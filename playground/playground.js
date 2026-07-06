// Nimbus playground - Phase 1 (text chat: batch/stream, history, latency).
// API keys live in localStorage and are sent per-request as headers.

const LS_KEYS = "nimbus_pg_keys";
const LS_BASE = "nimbus_pg_base";
const DEFAULT_BASE = window.NIMBUS_API_BASE || "http://localhost:8100";

const state = {
  base: localStorage.getItem(LS_BASE) || DEFAULT_BASE,
  keys: loadKeys(),
  mode: "batch",
  length: "medium",
  knowledge: "rag",
  session: newSession(),
  compareNext: false,
};

function loadKeys() {
  try { return JSON.parse(localStorage.getItem(LS_KEYS) || "{}"); } catch { return {}; }
}
function newSession() { return "pg-" + Math.random().toString(36).slice(2) + Date.now().toString(36); }
const $ = (id) => document.getElementById(id);

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (state.keys.openai) h["X-OpenAI-Key"] = state.keys.openai;
  if (state.keys.gemini) h["X-Gemini-Key"] = state.keys.gemini;
  if (state.keys.elevenlabs) h["X-ElevenLabs-Key"] = state.keys.elevenlabs;
  return h;
}

// ---- messages ----
function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = "msg msg-" + role;
  div.textContent = text;
  $("messages").append(div);
  $("messages").scrollTop = $("messages").scrollHeight;
  return div;
}

// ---- latency rendering ----
const STAGE_LABELS = {
  asr_ms: "ASR", rag_ms: "RAG", llm_total_ms: "LLM", tool_ms: "Tools",
  tts_ms: "TTS", buffer_ms: "Buffer",
};
function renderLatency(lat) {
  if (!lat) return;
  $("latTotal").textContent = Math.round(lat.total_ms);
  const max = Math.max(1, ...Object.keys(STAGE_LABELS).map((k) => lat[k] || 0));
  $("latBars").innerHTML = "";
  for (const [k, label] of Object.entries(STAGE_LABELS)) {
    const v = lat[k] || 0;
    const row = document.createElement("div");
    row.className = "lat-row";
    row.innerHTML = `<span>${label}</span><div class="bar"><i style="width:${(v / max) * 100}%"></i></div><span class="val">${Math.round(v)}ms</span>`;
    $("latBars").append(row);
  }
}
function setCmp(mode, lat) {
  const p = mode === "batch" ? "b" : "s";
  $(p + "Ttft").textContent = Math.round(lat.llm_ttft_ms) + "ms";
  $(p + "Total").textContent = Math.round(lat.total_ms) + "ms";
}
function renderMeta(meta) {
  if (!meta) return;
  let txt =
    `model: ${meta.model}\nmode: ${meta.mode}\n` +
    `prompt: ${meta.prompt_tokens} tokens (${meta.system_chars} sys chars)\n` +
    `verbatim msgs: ${meta.verbatim_messages}  summarized: ${meta.summarized_messages}\n` +
    `summary used: ${meta.summary_used}`;
  if (meta.rag) {
    const ch = (meta.rag.chunks || []).map((c) => `  ${c.score} ${c.doc}/${c.heading}`).join("\n");
    txt += `\nRAG: k=${meta.rag.k} rerank=${meta.rag.reranked}\n${ch}`;
  }
  $("meta").textContent = txt;
  renderTrace(meta.tool_calls || []);
}

function renderTrace(calls) {
  const box = $("toolTrace");
  if (!calls.length) { box.innerHTML = "<em>none</em>"; return; }
  box.innerHTML = "";
  for (const c of calls) {
    const d = document.createElement("div");
    d.className = "tc";
    d.innerHTML = `<b>${c.name}</b>(${escapeArgs(c.args)}) <small>${Math.round(c.ms)}ms</small>`;
    box.append(d);
  }
}
function escapeArgs(a) {
  const s = JSON.stringify(a || {});
  return s === "{}" ? "" : s.replace(/[<>&]/g, (m) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[m]));
}

async function refreshCart() {
  try {
    const r = await fetch(state.base + "/cart?session_id=" + encodeURIComponent(state.session));
    const d = await r.json();
    const box = $("cart");
    if (!d.items.length) { box.innerHTML = "<em>empty</em>"; return; }
    box.innerHTML = d.items.map((i) =>
      `<div class="cline"><span>${i.product_name} · ${i.tier} ×${i.seats}</span><span>$${i.price_monthly * i.seats}/mo</span></div>`
    ).join("") + `<div class="ctotal"><span>Monthly</span><span>$${d.monthly_total}/mo</span></div>`;
  } catch { /* ignore */ }
}

// ---- requests ----
function enabledToolNames() {
  const boxes = [...document.querySelectorAll("#toolList input")];
  if (!boxes.length) return null;                          // list not loaded yet -> all tools
  const checked = boxes.filter((c) => c.checked).map((c) => c.value);
  return checked.length === boxes.length ? null : checked; // all checked -> null (means all)
}

function requestPayload(message, mode) {
  const toolsOn = $("toolsEnabled").checked;
  return {
    session_id: state.session, message, mode,
    model_key: $("model").value,
    response_length: state.length,
    use_context: state.knowledge === "ragless",
    use_rag: state.knowledge === "rag",
    top_k: Number($("topk").value),
    rerank: $("rerank").checked,
    verbatim_turns: Number($("verbatim").value),
    temperature: Number($("temp").value) / 10,
    system_prompt: $("sysPrompt").value.trim() || null,
    tools_enabled: toolsOn,
    enabled_tools: toolsOn ? enabledToolNames() : [],
  };
}
function body(message, mode) { return JSON.stringify(requestPayload(message, mode)); }

// Shared agent config consumed by the website widget (same-origin localStorage).
const CFG_KEY = "nimbus_agent_config";
function persistConfig() {
  const toolsOn = $("toolsEnabled").checked;
  let prev = {};
  try { prev = JSON.parse(localStorage.getItem(CFG_KEY) || "{}"); } catch {}
  const next = {
    ...prev,
    model_key: $("model").value,
    response_length: state.length,
    knowledge: state.knowledge,
    top_k: Number($("topk").value),
    rerank: $("rerank").checked,
    verbatim_turns: Number($("verbatim").value),
    temperature: Number($("temp").value) / 10,
    system_prompt: $("sysPrompt").value.trim() || null,
    tools_enabled: toolsOn,
    enabled_tools: toolsOn ? enabledToolNames() : [],
  };
  localStorage.setItem(CFG_KEY, JSON.stringify(next));
}

async function sendBatch(message) {
  const el = addMsg("assistant", "...");
  const r = await fetch(state.base + "/chat", { method: "POST", headers: authHeaders(), body: body(message, "batch") });
  const data = await r.json();
  if (data.error) { el.className = "msg msg-error"; el.textContent = data.error; return; }
  el.textContent = data.text;
  renderLatency(data.latency); renderMeta(data.meta); setCmp("batch", data.latency);
}

async function sendStream(message) {
  const el = addMsg("assistant", "");
  el.innerHTML = '<span class="cursor">_</span>';
  let acc = "";
  const r = await fetch(state.base + "/chat/stream", { method: "POST", headers: authHeaders(), body: body(message, "stream") });
  if (!r.ok || !r.body) { el.className = "msg msg-error"; el.textContent = "Stream failed (" + r.status + ")"; return; }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop();
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.type === "delta") { acc += ev.text; el.textContent = acc; $("messages").scrollTop = $("messages").scrollHeight; }
      else if (ev.type === "error") { el.className = "msg msg-error"; el.textContent = ev.error; }
      else if (ev.type === "done") { renderLatency(ev.latency); renderMeta(ev.meta); setCmp("stream", ev.latency); }
    }
  }
}

async function onSend(message) {
  addMsg("user", message);
  setBusy(true);
  try {
    if (state.compareNext) {
      await sendBatch(message);
      await sendStream(message);
      state.compareNext = false; $("compareBtn").classList.remove("active");
    } else if (state.mode === "stream") {
      await sendStream(message);
    } else {
      await sendBatch(message);
    }
  } catch (e) {
    addMsg("error", "Request failed: " + e.message + " (is the backend running at " + state.base + "?)");
  } finally {
    setBusy(false);
    refreshCart();
  }
}

function setBusy(b) {
  $("input").disabled = b;
  document.querySelector("#composer button").disabled = b;
  if (!b) $("input").focus();
}

// ---- health + models ----
async function refreshHealth() {
  try {
    const r = await fetch(state.base + "/health");
    const d = await r.json();
    $("health").className = "pill pill-ok";
    $("health").textContent = `backend ok - corpus ${d.corpus.doc_count} docs`;
  } catch {
    $("health").className = "pill pill-bad";
    $("health").textContent = "backend unreachable";
  }
}
async function loadModels() {
  try {
    const r = await fetch(state.base + "/models");
    const d = await r.json();
    $("model").innerHTML = "";
    for (const m of d.models) {
      const o = document.createElement("option");
      o.value = m.key; o.textContent = m.label + (m.available ? "" : " (no key)");
      $("model").append(o);
    }
  } catch { /* health pill already shows the problem */ }
}

async function refreshRagStatus() {
  try {
    const r = await fetch(state.base + "/rag/status");
    const d = await r.json();
    if (d.built) {
      $("ragStatus").textContent = `index: ${d.chunks} chunks · ${d.model} (${d.dim}-d) · ${d.profile}`;
      $("rrLabel").textContent = d.profile === "rich" ? "(cross-encoder)" : "(LLM rerank, adds latency)";
    } else {
      $("ragStatus").innerHTML = 'index not built. <a href="rag.html" target="_blank">Build it &#8599;</a>';
    }
  } catch { $("ragStatus").textContent = "index status unavailable"; }
}

async function openInspector() {
  $("ctxTotals").textContent = "counting...";
  $("ctxBody").innerHTML = "";
  $("ctxDialog").showModal();
  try {
    const r = await fetch(state.base + "/inspect", {
      method: "POST", headers: authHeaders(), body: body("(preview)", "batch"),
    });
    const d = await r.json();
    if (d.error) { $("ctxTotals").textContent = d.error; return; }
    $("ctxTotals").innerHTML = `<b>${d.total_tokens.toLocaleString()}</b> tokens · ${d.total_chars.toLocaleString()} chars`;
    $("ctxBody").innerHTML = "";
    for (const m of d.messages) {
      const div = document.createElement("div");
      div.className = "ctx-msg";
      const pre = document.createElement("pre");
      pre.textContent = m.content;
      div.innerHTML = `<div class="ctx-mhead"><span class="role">${m.role}</span><span>${m.tokens} tokens · ${m.chars} chars</span></div>`;
      div.append(pre);
      $("ctxBody").append(div);
    }
  } catch (e) { $("ctxTotals").textContent = "inspect failed: " + e.message; }
}

async function loadTools() {
  try {
    const r = await fetch(state.base + "/tools");
    const d = await r.json();
    $("toolList").innerHTML = "";
    for (const t of d.tools) {
      const lab = document.createElement("label");
      lab.innerHTML = `<input type="checkbox" value="${t.name}" checked /><span><span class="tname">${t.name}</span> - ${t.description}</span>`;
      $("toolList").append(lab);
    }
  } catch { /* ignore */ }
}

// ---- wiring ----
function seg(id, onPick) {
  $(id).querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      $(id).querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active"); onPick(b.dataset.v);
    }));
}

function initSettings() {
  const dlg = $("settings");
  $("settingsBtn").addEventListener("click", () => {
    $("k_openai").value = state.keys.openai || "";
    $("k_gemini").value = state.keys.gemini || "";
    $("k_elevenlabs").value = state.keys.elevenlabs || "";
    $("apiBase").value = state.base;
    dlg.showModal();
  });
  dlg.addEventListener("close", () => {
    if (dlg.returnValue !== "save") return;
    state.keys = { openai: $("k_openai").value.trim(), gemini: $("k_gemini").value.trim(), elevenlabs: $("k_elevenlabs").value.trim() };
    localStorage.setItem(LS_KEYS, JSON.stringify(state.keys));
    state.base = $("apiBase").value.trim() || DEFAULT_BASE;
    localStorage.setItem(LS_BASE, state.base);
    refreshHealth(); loadModels();
  });
}

function init() {
  seg("mode", (v) => { state.mode = v; });
  seg("length", (v) => { state.length = v; persistConfig(); });
  $("verbatim").addEventListener("input", (e) => $("vbVal").textContent = e.target.value);
  $("temp").addEventListener("input", (e) => $("tempVal").textContent = (e.target.value / 10).toFixed(1));
  $("topk").addEventListener("input", (e) => $("kVal").textContent = e.target.value);
  seg("knowledge", (v) => {
    state.knowledge = v;
    $("ragOpts").hidden = v !== "rag";
    $("ctxHint").textContent = {
      ragless: "RAGless: full context.md is injected (large prompt).",
      rag: "RAG: top-k retrieved chunks are injected (smaller prompt, retrieval latency).",
      none: "No knowledge injected: the agent uses the model's own knowledge only.",
    }[v];
    if (v === "rag") refreshRagStatus();
    persistConfig();
  });
  const controlsPanel = document.querySelector(".controls");
  controlsPanel.addEventListener("change", persistConfig);
  controlsPanel.addEventListener("input", persistConfig);
  $("inspectBtn").addEventListener("click", openInspector);
  $("ctxClose").addEventListener("click", () => $("ctxDialog").close());
  $("compareBtn").addEventListener("click", () => {
    state.compareNext = !state.compareNext;
    $("compareBtn").classList.toggle("active", state.compareNext);
  });
  $("toolsEnabled").addEventListener("change", (e) => { $("toolsBox").hidden = !e.target.checked; });
  $("toolAll").addEventListener("click", (e) => { e.preventDefault(); document.querySelectorAll("#toolList input").forEach((c) => c.checked = true); });
  $("toolNone").addEventListener("click", (e) => { e.preventDefault(); document.querySelectorAll("#toolList input").forEach((c) => c.checked = false); });
  $("resetBtn").addEventListener("click", async () => {
    try { await fetch(state.base + "/session/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: state.session }) }); } catch {}
    state.session = newSession();
    $("messages").innerHTML = '<div class="msg msg-system">Conversation reset.</div>';
    refreshCart(); renderTrace([]);
  });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("input").value.trim();
    if (!v) return;
    $("input").value = "";
    onSend(v);
  });
  initSettings();
  // reflect the product defaults (RAG + tools on) in the UI on load
  $("ragOpts").hidden = state.knowledge !== "rag";
  $("toolsBox").hidden = !$("toolsEnabled").checked;
  if (state.knowledge === "rag") refreshRagStatus();
  refreshHealth(); loadModels(); loadTools().then(persistConfig); refreshCart();
  persistConfig();
}

init();
