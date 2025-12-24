import { config } from "./config.js";

export function buildSystemPrompt({ totalMemoryLines }) {
  const memoryBlock = totalMemoryLines.length
    ? totalMemoryLines.map((l, idx) => `${idx + 1}. ${l}`).join("\n")
    : "(empty)";

  return [
    "You are a helpful assistant.",
    "You have access to a persistent memory file called TOTAL_MEMORY.",
    "These memories are meant to be remembered forever unless they become irrelevant.",
    "Avoid duplicates: if a memory already exists, do not add it again.",
    "If you identify duplicate or irrelevant memories, request removals.",
    "IMPORTANT OUTPUT FORMAT:",
    "1) Write your normal user-facing answer in Markdown (NOT JSON).",
    "2) Then append a metadata block for memory/summary updates exactly like this:",
    "<<<MEMORY_JSON>>>\n{\n  \"memory\": {\n    \"remove\": [{\"lineStart\": number, \"exactText\": string}],\n    \"add\": [string]\n  },\n  \"summary\": {\n    \"update\": boolean,\n    \"text\": string\n  }\n}",
    "3) The metadata JSON must be valid JSON (no trailing commas, no comments, no code fences).",
    "4) If you do not want to change memory, use empty arrays. If you do not want to update summary, set update=false and text='' .",
    "Rules for memory removals:",
    "- lineStart is 1-based (first line is 1)",
    "- exactText must match the memory line(s) exactly as written in TOTAL_MEMORY (no renaming)",
    "- You may remove multiple memories in one response",
    "Rules for memory additions:",
    "- Each entry should be a single line memory",
    "- Do not add duplicates",
    "\nCURRENT TOTAL_MEMORY (with line numbers):\n" + memoryBlock
  ].join("\n");
}

export function buildMessages({ systemPrompt, sessionSummary, recentMessages, summaryWindowMessages }) {
  const messages = [{ role: "system", content: systemPrompt }];

  if (sessionSummary?.trim()) {
    messages.push({
      role: "system",
      content:
        "SESSION SUMMARY (older context, may be imperfect):\n" + sessionSummary.trim()
    });
  }

  if (summaryWindowMessages?.length) {
    const windowText = summaryWindowMessages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n");
    messages.push({
      role: "system",
      content:
        "OLDER MESSAGES TO SUMMARIZE (write summary.text if summary.update=true):\n" + windowText
    });
  }

  for (const msg of recentMessages) {
    messages.push({ role: msg.role, content: msg.content });
  }

  return messages;
}

export function splitForContext(allMessages) {
  const recentN = Math.max(1, config.recentMessages);
  const summaryN = Math.max(0, config.summaryMessages);

  const recentMessages = allMessages.slice(-recentN);

  // Take a window immediately before the recent messages for summarization.
  const summaryStart = Math.max(0, allMessages.length - recentN - summaryN);
  const summaryWindowMessages = allMessages.slice(summaryStart, Math.max(0, allMessages.length - recentN));

  return { recentMessages, summaryWindowMessages };
}
