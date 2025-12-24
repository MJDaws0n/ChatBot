import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return "";
    throw err;
  }
}

export async function writeTextAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmp = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, filePath);
}

export async function appendLine(filePath, line) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  await fs.appendFile(filePath, line.endsWith("\n") ? line : `${line}\n`, "utf8");
}

export async function readJson(filePath, fallback = null) {
  const txt = await readText(filePath);
  if (!txt) return fallback;
  return JSON.parse(txt);
}

export async function writeJsonAtomic(filePath, value) {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
