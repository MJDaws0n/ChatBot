import express from "express";
import path from "node:path";
import multer from "multer";
import { config } from "./config.js";
import { pickModel, chatCompletion } from "./openrouter.js";
import { appendMessage, readChat, readSummary, writeSummary } from "./sessionStore.js";
import { readTotalMemoryLines, writeTotalMemoryLines, applyMemoryEditsToLines } from "./memory.js";
import { buildMessages, buildSystemPrompt, splitForContext } from "./prompt.js";
import { renderMarkdownSafe } from "./markdown.js";
import { readFileAsDataUrl, safeFilename } from "./uploads.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Static UI
const publicDir = path.resolve("./public");
app.use(express.static(publicDir));

// Serve uploaded files from the persistent data volume.
app.use("/uploads", express.static(path.join(config.dataDir, "uploads")));

// Multipart upload handler
const storage = multer.diskStorage({
  destination: async (req, _file, cb) => {
    try {
      const sessionId = (req.body?.sessionId ?? "default").toString();
      const cleaned = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "default";
      const dest = path.join(config.dataDir, "uploads", cleaned);
      await import("./files.js").then(m => m.ensureDir(dest));
      cb(null, dest);
    } catch (e) {
      cb(e);
    }
  },
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const base = safeFilename(file.originalname);
    cb(null, `${ts}-${base}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024, files: 8 }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/", (_req, res) => {
  // express.static handles index.html automatically, but this makes it explicit.
  res.sendFile(path.join(publicDir, "index.html"));
});

// UI APIs
app.get("/api/session/:id", async (req, res) => {
  try {
    const sessionId = req.params.id;
    const messages = await readChat(sessionId);
    // For UI: include safe HTML rendering for assistant messages.
    const uiMessages = messages.map(m => {
      if (m.role === "assistant") {
        return { ...m, html: renderMarkdownSafe(m.content) };
      }
      return m;
    });

    // Best-effort: report the currently selected model.
    let model = null;
    try { model = await pickModel(); } catch { model = null; }

    res.json({ sessionId, model, messages: uiMessages });
  } catch (err) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.get("/api/session/:id/summary", async (req, res) => {
  try {
    const sessionId = req.params.id;
    const summary = await readSummary(sessionId);
    res.json({ sessionId, summary });
  } catch (err) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.get("/api/memory", async (_req, res) => {
  try {
    const lines = await readTotalMemoryLines();
    res.json({ lines });
  } catch (err) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

async function buildModelRecentMessagesWithImages(recentMessages) {
  const out = [];
  for (const msg of recentMessages) {
    if (msg.role !== "user" || !Array.isArray(msg.images) || msg.images.length === 0) {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    const parts = [];
    if (msg.content?.trim()) parts.push({ type: "text", text: msg.content });
    for (const img of msg.images) {
      if (!img?.filePath) continue;
      const dataUrl = await readFileAsDataUrl(img.filePath, img.mime);
      parts.push({ type: "image_url", image_url: { url: dataUrl } });
    }
    out.push({ role: "user", content: parts });
  }
  return out;
}

app.post("/api/chat", upload.array("images", 8), async (req, res) => {
  try {
    const sessionId = (req.body?.sessionId ?? "default").toString();
    const userMessage = (req.body?.message ?? "").toString();
    const files = Array.isArray(req.files) ? req.files : [];

    if (!userMessage.trim() && files.length === 0) {
      return res.status(400).json({ error: "message or images are required" });
    }

    const now = new Date().toISOString();
    const imageMeta = files.map(f => ({
      name: f.originalname,
      mime: f.mimetype,
      size: f.size,
      filePath: f.path,
      url: `/uploads/${encodeURIComponent(sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "default")}/${encodeURIComponent(path.basename(f.path))}`
    }));

    await appendMessage(sessionId, { ts: now, role: "user", content: userMessage, images: imageMeta });

    const [allMessages, sessionSummary, totalMemoryLines] = await Promise.all([
      readChat(sessionId),
      readSummary(sessionId),
      readTotalMemoryLines()
    ]);

    const { recentMessages, summaryWindowMessages } = splitForContext(allMessages);
    const systemPrompt = buildSystemPrompt({ totalMemoryLines });

    const recentForModel = await buildModelRecentMessagesWithImages(recentMessages);

    const messages = buildMessages({
      systemPrompt,
      sessionSummary,
      recentMessages: recentForModel,
      summaryWindowMessages: allMessages.length >= config.summaryMinMessages ? summaryWindowMessages : []
    });

    const model = await pickModel();
    const completion = await chatCompletion({ model, messages, responseFormatJson: true });
    const content = completion?.choices?.[0]?.message?.content ?? "";

    let parsed;
    try { parsed = JSON.parse(content); } catch { parsed = null; }

    if (!parsed || typeof parsed?.assistant_reply !== "string" || typeof parsed?.memory !== "object") {
      const assistantReply = content || "(empty response)";
      await appendMessage(sessionId, { ts: new Date().toISOString(), role: "assistant", content: assistantReply });
      return res.json({
        model,
        assistant_reply: assistantReply,
        assistant_html: renderMarkdownSafe(assistantReply),
        memory_applied: null,
        parse_error: "Model did not return valid JSON object schema"
      });
    }

    const assistantReply = parsed.assistant_reply;
    const memoryActions = parsed.memory;

    const beforeLines = totalMemoryLines;
    const { lines: afterLines, applied } = applyMemoryEditsToLines(beforeLines, memoryActions);
    await writeTotalMemoryLines(afterLines);

    const summary = parsed.summary;
    if (summary && summary.update === true && typeof summary.text === "string") {
      await writeSummary(sessionId, summary.text);
    }

    await appendMessage(sessionId, { ts: new Date().toISOString(), role: "assistant", content: assistantReply });

    return res.json({
      model,
      assistant_reply: assistantReply,
      assistant_html: renderMarkdownSafe(assistantReply),
      memory_applied: applied,
      memory_actions: memoryActions,
      summary_updated: summary?.update === true
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.post("/chat", async (req, res) => {
  try {
    const sessionId = (req.body?.sessionId ?? "default").toString();
    const userMessage = (req.body?.message ?? "").toString();
    if (!userMessage.trim()) {
      return res.status(400).json({ error: "message is required" });
    }

    const now = new Date().toISOString();
    await appendMessage(sessionId, { ts: now, role: "user", content: userMessage });

    const [allMessages, sessionSummary, totalMemoryLines] = await Promise.all([
      readChat(sessionId),
      readSummary(sessionId),
      readTotalMemoryLines()
    ]);

    const { recentMessages, summaryWindowMessages } = splitForContext(allMessages);

    const systemPrompt = buildSystemPrompt({ totalMemoryLines });
    const messages = buildMessages({
      systemPrompt,
      sessionSummary,
      recentMessages,
      summaryWindowMessages: allMessages.length >= config.summaryMinMessages ? summaryWindowMessages : []
    });

    const model = await pickModel();

    const completion = await chatCompletion({
      model,
      messages,
      responseFormatJson: true
    });

    const content = completion?.choices?.[0]?.message?.content ?? "";

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = null;
    }

    if (!parsed || typeof parsed?.assistant_reply !== "string" || typeof parsed?.memory !== "object") {
      // Fallback: treat content as plain assistant reply, no memory changes.
      const assistantReply = content || "(empty response)";
      await appendMessage(sessionId, { ts: new Date().toISOString(), role: "assistant", content: assistantReply });
      return res.json({
        model,
        assistant_reply: assistantReply,
        memory_applied: null,
        parse_error: "Model did not return valid JSON object schema"
      });
    }

    const assistantReply = parsed.assistant_reply;
    const memoryActions = parsed.memory;

    // Apply memory edits deterministically.
    const beforeLines = totalMemoryLines;
    const { lines: afterLines, applied } = applyMemoryEditsToLines(beforeLines, memoryActions);
    await writeTotalMemoryLines(afterLines);

    // Update session summary if asked.
    const summary = parsed.summary;
    if (summary && summary.update === true && typeof summary.text === "string") {
      await writeSummary(sessionId, summary.text);
    }

    await appendMessage(sessionId, { ts: new Date().toISOString(), role: "assistant", content: assistantReply });

    return res.json({
      model,
      assistant_reply: assistantReply,
      memory_applied: applied,
      memory_actions: memoryActions,
      summary_updated: summary?.update === true
    });
  } catch (err) {
    return res.status(500).json({
      error: err?.message ?? String(err)
    });
  }
});

app.listen(config.port, () => {
  console.log(`Server listening on port ${config.port}`);
});
