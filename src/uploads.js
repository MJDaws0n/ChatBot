import fs from "node:fs/promises";
import path from "node:path";

export function guessDataUrl(mimeType, buffer) {
  const base64 = buffer.toString("base64");
  const mime = mimeType || "application/octet-stream";
  return `data:${mime};base64,${base64}`;
}

export async function readFileAsDataUrl(filePath, mimeType) {
  const buf = await fs.readFile(filePath);
  return guessDataUrl(mimeType, buf);
}

export function safeFilename(name) {
  const base = (name || "upload").toString();
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned || "upload";
}

export function joinUnder(baseDir, ...parts) {
  return path.join(baseDir, ...parts);
}
