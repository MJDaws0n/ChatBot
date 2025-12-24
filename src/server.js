import express from "express";
import path from "node:path";
import multer from "multer";
import { config } from "./config.js";
import { pickModel, chatCompletion, chatCompletionStream } from "./openrouter.js";
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

function stripCodeFences(text) {
  const raw = (text ?? "").toString().trim();
  if (!raw.startsWith("```")) return raw;
  const lines = raw.split("\n");
  if (lines.length < 2) return raw;
  const first = lines[0].trim();
  const last = lines[lines.length - 1].trim();
  if (!first.startsWith("```") || last !== "```") return raw;
  return lines.slice(1, -1).join("\n").trim();
}

function extractAssistantAndMeta(fullText) {
  const text = (fullText ?? "").toString();
  const marker = "<<<MEMORY_JSON>>>";
  const idx = text.lastIndexOf(marker);
  if (idx === -1) {
    return { assistantReply: text.trim(), meta: null, metaError: null };
  }

  const assistantReply = text.slice(0, idx).trim();
  const metaRaw = text.slice(idx + marker.length).trim();
  const metaJsonText = stripCodeFences(metaRaw);

  try {
    const parsed = JSON.parse(metaJsonText);
    return { assistantReply, meta: parsed, metaError: null };
  } catch (e) {
    return {
      assistantReply: assistantReply || text.trim(),
      meta: null,
      metaError: e?.message ?? String(e)
    };
  }
}

function sendSse(res, data) {
  res.write(`data: ${data}\n\n`);
}

function sendSseJson(res, obj) {
  sendSse(res, JSON.stringify(obj));
}

function streamTextUntilMarker({ res, marker, onText }) {
  const markerLen = marker.length;
  let pending = "";
  let markerFound = false;

  const push = (delta) => {
    if (!delta) return;
    if (markerFound) return;

    const combined = pending + delta;
    const idx = combined.indexOf(marker);
    if (idx !== -1) {
      const visible = combined.slice(0, idx);
      if (visible) onText(visible);
      markerFound = true;
      pending = "";
      return;
    }

    const keep = Math.max(0, markerLen - 1);
    if (combined.length > keep) {
      const emit = combined.slice(0, combined.length - keep);
      if (emit) onText(emit);
      pending = combined.slice(combined.length - keep);
    } else {
      pending = combined;
    }
  };

  const flush = () => {
    if (!markerFound && pending) onText(pending);
    pending = "";
  };

  return { push, flush, get markerFound() { return markerFound; } };
}

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
    const completion = await chatCompletion({ model, messages, responseFormatJson: false });
    const content = completion?.choices?.[0]?.message?.content ?? "";

    const { assistantReply: assistantRaw, meta, metaError } = extractAssistantAndMeta(content);
    const assistantReply = assistantRaw || "(empty response)";

    let applied = null;
    let memoryActions = null;
    let summaryUpdated = false;

    if (meta && typeof meta === "object") {
      const memory = meta.memory;
      const summary = meta.summary;

      if (memory && typeof memory === "object") {
        memoryActions = memory;
        const beforeLines = totalMemoryLines;
        const after = applyMemoryEditsToLines(beforeLines, memoryActions);
        await writeTotalMemoryLines(after.lines);
        applied = after.applied;
      }

      if (summary && summary.update === true && typeof summary.text === "string") {
        await writeSummary(sessionId, summary.text);
        summaryUpdated = true;
      }
    }

    await appendMessage(sessionId, { ts: new Date().toISOString(), role: "assistant", content: assistantReply });

    return res.json({
      model,
      assistant_reply: assistantReply,
      assistant_html: renderMarkdownSafe(assistantReply),
      memory_applied: applied,
      memory_actions: memoryActions,
      summary_updated: summaryUpdated,
      meta_parse_error: metaError
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.post("/api/chat/stream", async (req, res) => {
  // SSE endpoint for live token streaming (text-only).
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // Reduce latency for small chunks.
  req.socket?.setNoDelay?.(true);

  // Some browsers/proxies buffer until a few KB are written.
  // This padding helps ensure the client sees early events immediately.
  res.write(`: stream-open\n`);
  res.write(`:${" ".repeat(2048)}\n\n`);

  const heartbeat = setInterval(() => {
    try {
      res.write(`: keep-alive ${Date.now()}\n\n`);
    } catch {
      // ignore
    }
  }, 15000);

  res.on("close", () => {
    clearInterval(heartbeat);
  });

  const marker = "<<<MEMORY_JSON>>>";
  const HTML_THROTTLE_MS = 140;
  let visibleText = "";
  let lastHtmlSentAt = 0;

  const maybeSendHtml = (force = false) => {
    const now = Date.now();
    if (!force && (now - lastHtmlSentAt) < HTML_THROTTLE_MS) return;
    lastHtmlSentAt = now;
    sendSseJson(res, { html: renderMarkdownSafe(visibleText) });
  };

  const streamCtl = streamTextUntilMarker({
    res,
    marker,
    onText: (delta) => {
      visibleText += delta;
      sendSseJson(res, { delta });
      maybeSendHtml(false);
    }
  });

  try {
    const sessionId = (req.body?.sessionId ?? "default").toString();
    const userMessage = (req.body?.message ?? "").toString();
    if (!userMessage.trim()) {
      sendSseJson(res, { error: "message is required" });
      sendSse(res, "[DONE]");
      return res.end();
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
    sendSseJson(res, { model });

    let fullText = "";
    for await (const evt of chatCompletionStream({ model, messages })) {
      const delta =
        evt?.choices?.[0]?.delta?.content ??
        evt?.choices?.[0]?.message?.content ??
        "";
      if (!delta) continue;
      fullText += delta;
      streamCtl.push(delta);
    }

    streamCtl.flush();
    maybeSendHtml(true);

    const { assistantReply: assistantRaw, meta } = extractAssistantAndMeta(fullText);
    const assistantReply = assistantRaw || "(empty response)";

    if (meta && typeof meta === "object") {
      const memory = meta.memory;
      const summary = meta.summary;

      if (memory && typeof memory === "object") {
        const after = applyMemoryEditsToLines(totalMemoryLines, memory);
        await writeTotalMemoryLines(after.lines);
      }

      if (summary && summary.update === true && typeof summary.text === "string") {
        await writeSummary(sessionId, summary.text);
      }
    }

    await appendMessage(sessionId, { ts: new Date().toISOString(), role: "assistant", content: assistantReply });
    sendSse(res, "[DONE]");
    clearInterval(heartbeat);
    return res.end();
  } catch (err) {
    sendSseJson(res, { error: err?.message ?? String(err) });
    sendSse(res, "[DONE]");
    clearInterval(heartbeat);
    return res.end();
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

    const completion = await chatCompletion({ model, messages, responseFormatJson: false });
    const content = completion?.choices?.[0]?.message?.content ?? "";

    const { assistantReply: assistantRaw, meta, metaError } = extractAssistantAndMeta(content);
    const assistantReply = assistantRaw || "(empty response)";

    const memoryActions = meta?.memory;

    // Apply memory edits deterministically.
    const beforeLines = totalMemoryLines;
    let applied = null;
    if (memoryActions && typeof memoryActions === "object") {
      const after = applyMemoryEditsToLines(beforeLines, memoryActions);
      await writeTotalMemoryLines(after.lines);
      applied = after.applied;
    }

    // Update session summary if asked.
    const summary = meta?.summary;
    if (summary && summary.update === true && typeof summary.text === "string") {
      await writeSummary(sessionId, summary.text);
    }

    await appendMessage(sessionId, { ts: new Date().toISOString(), role: "assistant", content: assistantReply });

    return res.json({
      model,
      assistant_reply: assistantReply,
      memory_applied: applied,
      memory_actions: memoryActions || null,
      summary_updated: summary?.update === true,
      meta_parse_error: metaError
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
