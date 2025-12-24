const $ = (sel) => document.querySelector(sel);

const state = {
  sessionId: "default",
  theme: "dark",
  sending: false,
  images: []
};

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

  $("#images").addEventListener("change", (e) => {
    const newFiles = Array.from(e.target.files || []);
    state.images = [...state.images, ...newFiles].slice(0, 8);
    renderSelectedImages();
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
