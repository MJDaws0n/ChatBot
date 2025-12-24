const $ = (sel) => document.querySelector(sel);

const state = {
  sessionId: "default",
  theme: "dark",
  sending: false,
  images: []
};

function ensureToastHost() {
  let host = document.querySelector("#toastHost");
  if (!host) {
    host = document.createElement("div");
    host.id = "toastHost";
    host.className = "toast-host";
    host.setAttribute("aria-live", "polite");
    host.setAttribute("aria-atomic", "true");
    document.body.appendChild(host);
  }
  return host;
}

function showToast({ title, message, timeoutMs = 7000 } = {}) {
  const host = ensureToastHost();
  host.innerHTML = "";

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "status");

  const content = document.createElement("div");
  content.className = "toast-content";

  const t = document.createElement("div");
  t.className = "toast-title";
  t.textContent = title || "Notice";

  const m = document.createElement("div");
  m.className = "toast-message";
  m.textContent = message || "";

  content.appendChild(t);
  if (m.textContent) content.appendChild(m);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "Close");
  close.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  `;

  const remove = () => {
    if (!toast.isConnected) return;
    toast.classList.add("toast-leave");
    window.setTimeout(() => toast.remove(), 160);
  };

  close.addEventListener("click", remove);
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") remove();
    },
    { once: true }
  );

  toast.appendChild(content);
  toast.appendChild(close);
  host.appendChild(toast);

  if (timeoutMs > 0) {
    window.setTimeout(remove, timeoutMs);
  }
}

function loadTheme() {
  const saved = localStorage.getItem("theme");
  state.theme = saved || (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.setAttribute("data-theme", state.theme);
}

function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", state.theme);
  localStorage.setItem("theme", state.theme);
}

function loadSessionId() {
  const saved = localStorage.getItem("sessionId");
  state.sessionId = saved || "default";
}

function escapeHtml(str) {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function copyToClipboard(text) {
  const value = (text ?? "").toString();
  if (!value) return false;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // fall through to legacy copy
    }
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.left = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function enhanceCodeBlocks(rootEl) {
  if (!rootEl) return;
  const pres = rootEl.querySelectorAll("pre");
  for (const pre of pres) {
    const code = pre.querySelector("code");
    if (!code) continue;
    if (pre.querySelector(".code-copy-btn")) continue;

    pre.classList.add("has-copy");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy-btn";
    btn.textContent = "Copy";

    let resetTimer = null;
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const ok = await copyToClipboard(code.textContent);
      btn.textContent = ok ? "Copied" : "Failed";
      btn.classList.toggle("is-ok", ok);
      btn.classList.toggle("is-fail", !ok);
      if (resetTimer) window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(() => {
        btn.textContent = "Copy";
        btn.classList.remove("is-ok", "is-fail");
      }, 1400);
    });

    pre.appendChild(btn);
  }
}

function renderMessage({ role, ts, content, html, images }) {
  const wrap = document.createElement("div");
  wrap.className = "msg";

  const avatar = document.createElement("div");
  avatar.className = `avatar ${role === "user" ? "user" : "ai"}`;
  avatar.textContent = role === "user" ? "U" : "AI";

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const meta = document.createElement("div");
  meta.className = "meta";
  const who = role === "user" ? "You" : "Assistant";
  const time = ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "";
  meta.innerHTML = `<span class="meta-name">${escapeHtml(who)}</span><span class="meta-time">${escapeHtml(time)}</span>`;

  const body = document.createElement("div");
  body.className = "md";
  if (role === "assistant" && html) {
    body.innerHTML = html;
    enhanceCodeBlocks(body);
  } else {
    body.textContent = content || "";
  }

  bubble.appendChild(meta);
  bubble.appendChild(body);

  if (Array.isArray(images) && images.length) {
    const imgs = document.createElement("div");
    imgs.className = "images";
    for (const img of images) {
      const box = document.createElement("div");
      box.className = "img";
      const el = document.createElement("img");
      el.alt = img.name || "uploaded";
      el.src = img.url;
      box.appendChild(el);
      imgs.appendChild(box);
    }
    bubble.appendChild(imgs);
  }

  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  return wrap;
}

function scrollToBottom() {
  const el = $("#messages");
  el.scrollTop = el.scrollHeight;
}

function setPanel(open, title = "", content = "") {
  const panel = $("#panel");
  panel.setAttribute("aria-hidden", open ? "false" : "true");
  $("#panelTitle").textContent = title;
  const body = $("#panelBody");
  body.innerHTML = "";
  const pre = document.createElement("pre");
  pre.textContent = content;
  body.appendChild(pre);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

function showLoading() {
  const messagesEl = $("#messages");
  const existing = messagesEl.querySelector(".loading");
  if (existing) return;
  
  const loading = document.createElement("div");
  loading.className = "msg loading";
  loading.innerHTML = `
    <div class="avatar ai">AI</div>
    <div class="bubble">
      <div class="loading-dots">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </div>
  `;
  messagesEl.appendChild(loading);
  scrollToBottom();
}

function hideLoading() {
  const loading = $("#messages .loading");
  if (loading) loading.remove();
}

async function streamChat({ sessionId, message, onDelta, onHtml, onModel }) {
  const res = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, message })
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const event = buf.slice(0, sep);
      buf = buf.slice(sep + 2);

      const lines = event.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") return;

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        if (parsed?.error) throw new Error(parsed.error);
        if (parsed?.model && onModel) onModel(parsed.model);
        if (typeof parsed?.delta === "string" && onDelta) onDelta(parsed.delta);
        if (typeof parsed?.html === "string" && onHtml) onHtml(parsed.html);
      }
    }
  }
}

async function loadHistory() {
  const data = await fetchJson(`/api/session/${encodeURIComponent(state.sessionId)}`);
  const messagesEl = $("#messages");
  messagesEl.innerHTML = "";

  if (data.messages.length === 0) {
    messagesEl.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <p>Start a conversation by typing a message below</p>
      </div>
    `;
    return;
  }

  for (const m of data.messages) {
    messagesEl.appendChild(renderMessage(m));
  }
  scrollToBottom();
}

function renderSelectedImages() {
  const pills = $("#imagePills");
  pills.innerHTML = "";
  for (let i = 0; i < state.images.length; i++) {
    const f = state.images[i];
    const pill = document.createElement("div");
    pill.className = "pill";
    
    const name = document.createElement("span");
    name.textContent = f.name.length > 20 ? f.name.slice(0, 17) + "..." : f.name;
    
    const remove = document.createElement("span");
    remove.className = "pill-remove";
    remove.textContent = "×";
    remove.dataset.index = i;
    remove.onclick = (e) => {
      const idx = parseInt(e.target.dataset.index);
      state.images.splice(idx, 1);
      renderSelectedImages();
    };
    
    pill.appendChild(name);
    pill.appendChild(remove);
    pills.appendChild(pill);
  }
}

function autoResizeTextarea() {
  const textarea = $("#message");
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
}

async function send() {
  if (state.sending) return;

  const text = $("#message").value;
  const files = state.images;
  if (!text.trim() && (!files || !files.length)) return;

  state.sending = true;
  $("#send").disabled = true;

  const messagesEl = $("#messages");
  const emptyState = messagesEl.querySelector(".empty-state");
  if (emptyState) emptyState.remove();

  const userMsg = renderMessage({
    role: "user",
    ts: new Date().toISOString(),
    content: text,
    images: files.map(f => ({ name: f.name, url: URL.createObjectURL(f) }))
  });
  messagesEl.appendChild(userMsg);
  scrollToBottom();

  $("#message").value = "";
  autoResizeTextarea();
  
  showLoading();

  try {
    // Stream for text-only messages for a ChatGPT-like live output.
    const canStream = !files || files.length === 0;
    if (canStream) {
      hideLoading();

      const assistantMsg = renderMessage({
        role: "assistant",
        ts: new Date().toISOString(),
        content: ""
      });
      messagesEl.appendChild(assistantMsg);
      scrollToBottom();

      const bodyEl = assistantMsg.querySelector(".md");
      let acc = "";
      let usingHtml = false;

      await streamChat({
        sessionId: state.sessionId,
        message: text,
        onDelta: (d) => {
          acc += d;
          if (!usingHtml) {
            bodyEl.textContent = acc;
            scrollToBottom();
          }
        },
        onHtml: (html) => {
          usingHtml = true;
          bodyEl.innerHTML = html;
          enhanceCodeBlocks(bodyEl);
          scrollToBottom();
        },
        onModel: () => {}
      });

      // Re-load history so markdown formatting + copy buttons apply.
      await loadHistory();
    } else {
      const form = new FormData();
      form.set("sessionId", state.sessionId);
      form.set("message", text);
      for (const f of files) form.append("images", f);

      const res = await fetch("/api/chat", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);

      state.images = [];
      $("#images").value = "";
      renderSelectedImages();

      hideLoading();
      await loadHistory();
    }
  } catch (err) {
    console.error(err);
    hideLoading();
    const errorMsg = document.createElement("div");
    errorMsg.className = "msg";
    errorMsg.innerHTML = `
      <div class="avatar ai">AI</div>
      <div class="bubble">
        <div class="meta">
          <span class="meta-name">Error</span>
        </div>
        <div class="md" style="color: #ff453a;">${escapeHtml(err.message || "Something went wrong")}</div>
      </div>
    `;
    messagesEl.appendChild(errorMsg);
    scrollToBottom();
  } finally {
    state.sending = false;
    $("#send").disabled = false;
  }
}

async function showSummary() {
  const data = await fetchJson(`/api/session/${encodeURIComponent(state.sessionId)}/summary`);
  setPanel(true, "Session Summary", data.summary || "(No summary available)");
}

async function showMemory() {
  const data = await fetchJson(`/api/memory`);
  const lines = Array.isArray(data.lines) ? data.lines : [];
  const text = lines.length ? lines.map((l, i) => `${i + 1}. ${l}`).join("\n") : "(No memories stored)";
  setPanel(true, "Memory Bank", text);
}

function wireEvents() {
  $("#toggleTheme").addEventListener("click", toggleTheme);

  // OpenRouter may return: "No endpoints found that support image input" for non-vision models.
  // Instead of letting users pick images and then failing, show a friendly in-app popup.
  const imageUpload = $("#imageUpload");
  const imagesInput = $("#images");

  const showImageNotSupported = () => {
    showToast({
      title: "Images not supported",
      message:
        "This chat model doesn't support image input on OpenRouter (HTTP 404: No endpoints found that support image input). I need to sort this out or find out why. For now images don't work with this model.",
      timeoutMs: 9000
    });
  };

  imageUpload.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showImageNotSupported();
  });

  imageUpload.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      showImageNotSupported();
    }
  });

  imagesInput.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showImageNotSupported();
  });

  imagesInput.addEventListener("change", (e) => {
    // Defensive: if a browser still allows selection somehow, clear it.
    e.target.value = "";
    showImageNotSupported();
  });

  $("#send").addEventListener("click", send);

  $("#message").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  $("#message").addEventListener("input", autoResizeTextarea);

  $("#showSummary").addEventListener("click", showSummary);
  $("#showMemory").addEventListener("click", showMemory);
  $("#closePanel").addEventListener("click", () => setPanel(false));
}

async function main() {
  loadTheme();
  loadSessionId();
  wireEvents();
  await loadHistory();
}

main().catch((e) => {
  console.error(e);
});
