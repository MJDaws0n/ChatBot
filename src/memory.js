import path from "node:path";
import { config } from "./config.js";
import { readText, writeTextAtomic, ensureDir } from "./files.js";

export function totalMemoryPath() {
  return path.join(config.dataDir, "total_memory.txt");
}

function normalizeLine(line) {
  return line.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export async function readTotalMemoryLines() {
  const txt = await readText(totalMemoryPath());
  const normalized = normalizeLine(txt);
  const rawLines = normalized.split("\n");
  // Remove trailing final empty line if file ends with \n
  const lines = rawLines.length && rawLines[rawLines.length - 1] === "" ? rawLines.slice(0, -1) : rawLines;
  return lines;
}

export async function writeTotalMemoryLines(lines) {
  await ensureDir(config.dataDir);
  const trimmed = lines.slice(0, config.memoryMaxLines);
  const content = trimmed.length ? `${trimmed.join("\n")}\n` : "";
  await writeTextAtomic(totalMemoryPath(), content);
}

export function applyMemoryEditsToLines(lines, actions) {
  if (!actions || typeof actions !== "object") return { lines, applied: { removed: 0, added: 0, deduped: 0 } };

  let next = [...lines];
  let removed = 0;
  let added = 0;

  const removals = Array.isArray(actions.remove) ? actions.remove : [];
  // Remove in descending lineStart so indices don't shift.
  const sortedRemovals = removals
    .filter(r => r && Number.isInteger(r.lineStart) && typeof r.exactText === "string")
    .map(r => ({ lineStart: r.lineStart, exactText: r.exactText }))
    .sort((a, b) => b.lineStart - a.lineStart);

  for (const r of sortedRemovals) {
    const startIndex = r.lineStart - 1;
    if (startIndex < 0 || startIndex >= next.length) continue;

    const exactLines = normalizeLine(r.exactText).split("\n");
    const exact = exactLines.length && exactLines[exactLines.length - 1] === "" ? exactLines.slice(0, -1) : exactLines;
    if (!exact.length) continue;

    const candidate = next.slice(startIndex, startIndex + exact.length);
    const matches = candidate.length === exact.length && candidate.every((line, i) => line === exact[i]);
    if (!matches) continue;

    next.splice(startIndex, exact.length);
    removed += exact.length;
  }

  const additions = Array.isArray(actions.add) ? actions.add : [];
  for (const memory of additions) {
    if (typeof memory !== "string") continue;
    const line = memory.trim();
    if (!line) continue;
    if (next.includes(line)) continue;
    next.push(line);
    added += 1;
  }

  // Dedupe exact matches; keep first occurrence.
  const seen = new Set();
  const deduped = [];
  let dedupeRemoved = 0;
  for (const line of next) {
    const key = line;
    if (seen.has(key)) {
      dedupeRemoved += 1;
      continue;
    }
    seen.add(key);
    deduped.push(line);
  }

  return {
    lines: deduped,
    applied: { removed, added, deduped: dedupeRemoved }
  };
}
