import path from "node:path";
import fs from "node:fs/promises";
import { config } from "./config.js";
import { appendLine, ensureDir, readText, writeTextAtomic } from "./files.js";

function safeSessionId(sessionId) {
  const raw = (sessionId ?? "default").toString();
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || "default";
}

export function sessionPaths(sessionId) {
  const id = safeSessionId(sessionId);
  const dir = path.join(config.dataDir, "sessions", id);
  return {
    dir,
    chatLog: path.join(dir, "chat.jsonl"),
    summary: path.join(dir, "summary.txt")
  };
}

export async function appendMessage(sessionId, msg) {
  const { dir, chatLog } = sessionPaths(sessionId);
  await ensureDir(dir);
  await appendLine(chatLog, JSON.stringify(msg));
}

export async function readChat(sessionId) {
  const { chatLog } = sessionPaths(sessionId);
  const txt = await readText(chatLog);
  if (!txt.trim()) return [];
  const lines = txt.split("\n").filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj?.role && typeof obj?.content === "string") {
        // Preserve extra fields (ts, images, html, etc.) for UI.
        out.push(obj);
      }
    } catch {
      // ignore corrupt lines
    }
  }
  return out;
}

export async function readSummary(sessionId) {
  const { summary } = sessionPaths(sessionId);
  return await readText(summary);
}

export async function writeSummary(sessionId, text) {
  const { dir, summary } = sessionPaths(sessionId);
  await ensureDir(dir);
  await writeTextAtomic(summary, text ? `${text.trim()}\n` : "");
}

export async function chatCount(sessionId) {
  const { chatLog } = sessionPaths(sessionId);
  try {
    const txt = await fs.readFile(chatLog, "utf8");
    return txt.split("\n").filter(Boolean).length;
  } catch (err) {
    if (err && err.code === "ENOENT") return 0;
    throw err;
  }
}
