// Nimbus voice agent - Phase 4.
// Turn-based loop: mic -> VAD endpointing -> ASR -> /chat -> TTS -> buffered
// playback, with barge-in and a combined per-stage latency pie.

const LS_KEYS = "nimbus_pg_keys";
const LS_BASE = "nimbus_pg_base";
const BASE = localStorage.getItem(LS_BASE) || window.NIMBUS_API_BASE || "http://localhost:8100";
const $ = (id) => document.getElementById(id);

const PIE = {
  asr_ms: ["ASR", "#3fb0c9"], rag_ms: ["RAG", "#9d7bff"], llm_total_ms: ["LLM", "#6e8bff"],
  tool_ms: ["Tools", "#2ea043"], tts_ms: ["TTS", "#d29922"], buffer_ms: ["Buffer", "#e06aa8"],
  other_ms: ["Other/net", "#8b93a7"],
};

const state = {
  session: "voice-" + Math.random().toString(36).slice(2),
  on: false, phase: "idle",     // idle|listening|recording|thinking|speaking
  keys: loadKeys(),
  stream: null, ac: null, analyser: null, buf: null,
  recorder: null, chunks: [], lastVoice: 0, speechStart: 0, noiseFloor: 0.01,
  rec: null,                    // SpeechRecognition (browser ASR)
  speechEndTs: 0,
  // Web Audio TTS playback + double-talk barge state
  ttsAnalyser: null, ttsBuf: null, queue: [], source: null, playing: false,
  cancelled: false, mode: "batch",
  playStartTs: 0, echoGain: 0.4, bargeFrames: 0, turnStart: 0, firstAudioAt: 0,
};

// Barge-in: a double-talk detector. We play TTS through Web Audio so we can
// measure the output envelope, estimate how much of it echoes into the mic, and
// flag user speech only when the mic energy exceeds that predicted echo.
const BARGE_GRACE_MS = 140;       // learn echo coupling before judging
const START_FRAMES = 3;           // sustained voice frames before recording (rejects taps)
// Presets: higher threshold + more sustained frames = harder to trigger.
const BARGE_PRESETS = {
  off: { enabled: false, threshold: 1, frames: 999 },
  low: { enabled: true, threshold: 0.06, frames: 7 },      // least sensitive
  medium: { enabled: true, threshold: 0.045, frames: 5 },
  high: { enabled: true, threshold: 0.032, frames: 4 },    // most sensitive (default)
};
function bargeCfg() { return BARGE_PRESETS[$("barge").value] || BARGE_PRESETS.medium; }
// A transcript is real speech only if >=2 letters remain after removing
// bracketed audio-event tags like "(footsteps)" or "[laughter]".
function isSpeech(t) {
  const w = (t || "").replace(/[\(\[\{\*][^\)\]\}\*]*[\)\]\}\*]/g, "").replace(/[^A-Za-z0-9À-ɏऀ-෿]+/g, "");
  return w.length >= 2;
}

function loadKeys() { try { return JSON.parse(localStorage.getItem(LS_KEYS) || "{}"); } catch { return {}; } }
function authHeaders(extra) {
  const h = { ...(extra || {}) };
  if (state.keys.openai) h["X-OpenAI-Key"] = state.keys.openai;
  if (state.keys.gemini) h["X-Gemini-Key"] = state.keys.gemini;
  if (state.keys.elevenlabs) h["X-ElevenLabs-Key"] = state.keys.elevenlabs;
  return h;
}

// ---- UI helpers ----
function setPhase(p, text) {
  state.phase = p;
  $("status").textContent = p;
  $("status").className = "pill " + (p === "idle" ? "pill-muted" : "pill-ok");
  $("mic").className = "mic-btn" + (p === "recording" ? " recording" : p === "speaking" ? " speaking" : state.on ? " listening" : "");
  if (text) $("phase").textContent = text;
}
function addMsg(role, text) {
  const d = document.createElement("div");
  d.className = "t-msg t-" + role;
  d.textContent = text;
  $("transcript").append(d);
  $("transcript").scrollTop = $("transcript").scrollHeight;
  return d;
}
function addMetaLine(text) {
  const d = document.createElement("div");
  d.className = "t-meta"; d.textContent = text;
  $("transcript").append(d); $("transcript").scrollTop = $("transcript").scrollHeight;
}

// ---- latency pie ----
function renderPie(lat) {
  const ctx = $("pie").getContext("2d");
  const W = $("pie").width, cx = W / 2, cy = W / 2, r = W / 2 - 6;
  ctx.clearRect(0, 0, W, W);
  const entries = Object.keys(PIE).map((k) => [k, lat[k] || 0]);
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
  let a = -Math.PI / 2;
  for (const [k, v] of entries) {
    if (v <= 0) continue;
    const slice = (v / total) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, a, a + slice);
    ctx.closePath(); ctx.fillStyle = PIE[k][1]; ctx.fill();
    a += slice;
  }
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2); ctx.fillStyle = "#161b22"; ctx.fill();
  $("latTotal").textContent = Math.round(total);
  $("pieLegend").innerHTML = entries.map(([k, v]) =>
    `<div class="pl"><span class="dot" style="background:${PIE[k][1]}"></span><span>${PIE[k][0]}</span><span>${Math.round(v)}ms (${Math.round(v / total * 100)}%)</span></div>`
  ).join("");
}

// ---- mic + analyser ----
async function ensureMic() {
  if (state.stream) return;
  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  state.ac = new (window.AudioContext || window.webkitAudioContext)();
  const src = state.ac.createMediaStreamSource(state.stream);
  state.analyser = state.ac.createAnalyser();
  state.analyser.fftSize = 1024;
  state.buf = new Float32Array(state.analyser.fftSize);
  src.connect(state.analyser);
  // analyser on the TTS output path so we know what we're playing (echo reference)
  state.ttsAnalyser = state.ac.createAnalyser();
  state.ttsAnalyser.fftSize = 1024;
  state.ttsBuf = new Float32Array(state.ttsAnalyser.fftSize);
  state.ttsAnalyser.connect(state.ac.destination);
}
function rmsOf(analyser, buf) {
  analyser.getFloatTimeDomainData(buf);
  let s = 0;
  for (const x of buf) s += x * x;
  return Math.sqrt(s / buf.length);
}
function rms() { return rmsOf(state.analyser, state.buf); }
function ttsLevel() { return state.playing ? rmsOf(state.ttsAnalyser, state.ttsBuf) : 0; }
function speechThreshold() { return Math.max(0.02, state.noiseFloor * 2.5 + 0.012); }

async function calibrate() {
  const samples = [];
  const t0 = performance.now();
  while (performance.now() - t0 < 500) {
    samples.push(rms());
    await new Promise((r) => setTimeout(r, 30));
  }
  state.noiseFloor = samples.reduce((a, b) => a + b, 0) / samples.length;
}

// ---- VAD loop ----
function loop() {
  if (!state.on) return;
  const level = rms();
  $("levelBar").style.width = Math.min(100, level * 600) + "%";
  const th = speechThreshold();
  const now = performance.now();
  const serverMode = $("asr").value !== "browser";

  // barge-in while speaking: subtract predicted echo from the mic, flag the rest
  if (state.phase === "speaking") {
    const bc = bargeCfg();
    const out = ttsLevel();
    const residual = level - state.echoGain * out;        // mic energy not explained by our audio
    const since = now - state.playStartTs;
    const speaking = residual > bc.threshold;
    if (!speaking && out > 0.005) {
      // adapt echo coupling only when the user is NOT talking
      state.echoGain = Math.min(4, Math.max(0, state.echoGain * 0.97 + (level / out) * 0.03));
    }
    if (bc.enabled && since > BARGE_GRACE_MS) {
      // Require sustained speech-band energy; a single loud transient (tap,
      // footstep) is too brief to accumulate frames, and dips decay quickly.
      state.bargeFrames = speaking ? state.bargeFrames + 1 : Math.max(0, state.bargeFrames - 2);
      if (state.bargeFrames >= bc.frames) bargeIn();
    }
  } else if (serverMode && state.phase === "listening") {
    if (level > th) { state.listenFrames = (state.listenFrames || 0) + 1; if (state.listenFrames >= START_FRAMES) { state.listenFrames = 0; beginRecording(); } }
    else { state.listenFrames = Math.max(0, (state.listenFrames || 0) - 1); }
  } else if (serverMode && state.phase === "recording") {
    if (level > th) state.lastVoice = now;
    if (now - state.lastVoice > Number($("endpoint").value)) endRecording();
  }
  requestAnimationFrame(loop);
}

// ---- server-ASR capture (MediaRecorder) ----
function beginRecording() {
  state.chunks = [];
  state.recorder = new MediaRecorder(state.stream, { mimeType: pickMime() });
  state.recorder.ondataavailable = (e) => { if (e.data.size) state.chunks.push(e.data); };
  state.recorder.onstop = onRecordingStop;
  state.recorder.start();
  state.speechStart = performance.now();
  state.lastVoice = performance.now();
  setPhase("recording", "listening to you...");
}
function endRecording() {
  if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop();
}
async function onRecordingStop() {
  const blob = new Blob(state.chunks, { type: state.recorder.mimeType });
  if (blob.size < 1200) { setPhase("listening", "(too short, ignored)"); return; }
  setPhase("thinking", "transcribing...");
  const fd = new FormData();
  fd.append("provider", $("asr").value);
  fd.append("language", ($("asrLang") && $("asrLang").value) || "en");
  fd.append("file", blob, "utt.webm");
  try {
    const r = await fetch(BASE + "/asr", { method: "POST", headers: authHeaders(), body: fd });
    const d = await r.json();
    if (d.error) { setPhase("listening", "ASR error: " + d.error); return; }
    if (!isSpeech(d.text)) { setPhase("listening", "(ignored background noise)"); return; }
    addMsg("user", d.text.trim());
    await runPipeline(d.text.trim(), d.asr_ms || 0);
  } catch (e) { setPhase("listening", "ASR failed: " + e.message); }
}
function pickMime() {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"])
    if (MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

// ---- browser ASR (Web Speech API) ----
function startBrowserASR() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { setPhase("listening", "Browser ASR not supported here; pick another ASR."); return; }
  const rec = new SR();
  const BCP47 = { en: "en-US", ta: "ta-IN", hi: "hi-IN", te: "te-IN", ml: "ml-IN", kn: "kn-IN",
                  es: "es-ES", fr: "fr-FR", de: "de-DE", ja: "ja-JP", zh: "zh-CN", ar: "ar-SA", pt: "pt-BR", ru: "ru-RU" };
  const langSel = ($("asrLang") && $("asrLang").value) || "en";
  rec.continuous = true; rec.interimResults = false; rec.lang = BCP47[langSel] || "en-US";
  rec.onspeechend = () => { state.speechEndTs = performance.now(); };
  rec.onresult = async (ev) => {
    const text = ev.results[ev.results.length - 1][0].transcript.trim();
    if (!isSpeech(text) || state.phase === "thinking" || state.phase === "speaking") return;
    addMsg("user", text);
    const asrMs = state.speechEndTs ? Math.round(performance.now() - state.speechEndTs) : 0;
    await runPipeline(text, asrMs);
  };
  rec.onerror = () => {};
  rec.onend = () => { if (state.on && $("asr").value === "browser") { try { rec.start(); } catch {} } };
  state.rec = rec;
  try { rec.start(); } catch {}
}
function stopBrowserASR() { if (state.rec) { state.rec.onend = null; try { state.rec.stop(); } catch {} state.rec = null; } }

// ---- pipeline: chat -> tts ----
function chatBody(message, mode) {
  const know = document.querySelector("#knowledge .active").dataset.v;
  return JSON.stringify({
    session_id: state.session, message, mode,
    model_key: $("model").value, response_length: "low",
    use_context: know === "ragless", use_rag: know === "rag", top_k: 4,
    tools_enabled: $("toolsEnabled").checked,
    enabled_tools: $("toolsEnabled").checked ? null : [],
  });
}

async function runPipeline(userText, asrMs) {
  state.cancelled = false;
  state.turnStart = performance.now();
  state.firstAudioAt = 0;
  if ($("asr").value === "browser") stopBrowserASR();  // avoid hearing our own audio
  if (state.mode === "stream") await pipelineStream(userText, asrMs);
  else await pipelineBatch(userText, asrMs);
}

// ---- batch: full LLM, then full TTS ----
async function pipelineBatch(userText, asrMs) {
  setPhase("thinking", "thinking...");
  let chat;
  try {
    const r = await fetch(BASE + "/chat", { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: chatBody(userText, "batch") });
    chat = await r.json();
  } catch (e) { setPhase("listening", "chat failed: " + e.message); return; }
  if (chat.error) { setPhase("listening", "chat error: " + chat.error); return; }
  state.lastBubble = addMsg("assistant", chat.text);
  setPhase("thinking", "synthesizing voice...");
  const tts = await synth(chat.text);
  if (!tts) { resumeListening(); return; }
  const lat = { ...chat.latency, asr_ms: asrMs, tts_ms: tts.ms, buffer_ms: Number($("buffer").value) };
  beginSpeaking();
  await new Promise((r) => setTimeout(r, lat.buffer_ms)); // pre-buffer
  enqueue(tts.audio);
  finishTurn(lat, "batch");
}

// ---- streaming: speak sentence-by-sentence as the LLM writes ----
async function pipelineStream(userText, asrMs) {
  setPhase("thinking", "thinking...");
  const bubble = addMsg("assistant", "");
  state.lastBubble = bubble;
  let acc = "", pending = "", spoke = false, meta = null, lat0 = null;
  // capture the pieces that gate time-to-first-audio (the FIRST sentence only)
  let firstSentenceTs = 0, firstSynthMs = 0;
  const flush = async (text) => {
    const t = text.trim();
    if (!t || state.cancelled) return;
    const fs = performance.now();
    const tts = await synth(t);
    if (!tts || state.cancelled) return;
    if (!firstSentenceTs) { firstSentenceTs = fs; firstSynthMs = performance.now() - fs; }
    if (!spoke) { spoke = true; beginSpeaking(); await new Promise((r) => setTimeout(r, Number($("buffer").value))); }
    enqueue(tts.audio);
  };
  try {
    const r = await fetch(BASE + "/chat/stream", { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: chatBody(userText, "stream") });
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done || state.cancelled) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n"); buf = parts.pop();
      for (const p of parts) {
        const line = p.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === "delta") {
          acc += ev.text; pending += ev.text; bubble.textContent = acc;
          let m;
          while ((m = pending.match(/[^.!?]*[.!?]+(\s|$)/)) && m[0].trim().length > 2) {
            await flush(m[0]); pending = pending.slice(m[0].length);
          }
        } else if (ev.type === "done") { meta = ev.meta; lat0 = ev.latency; }
        else if (ev.type === "error") { bubble.textContent = "error: " + ev.error; }
      }
    }
    if (pending.trim()) await flush(pending);
  } catch (e) { bubble.textContent = "stream failed: " + e.message; resumeListening(); return; }
  if (state.cancelled) return;
  if (!spoke) { resumeListening(); return; }
  // TTFA breakdown: only the first sentence's LLM + TTS gate first audio
  const ragMs = (lat0 && lat0.rag_ms) || 0;
  const llmToFirst = firstSentenceTs ? firstSentenceTs - state.turnStart : 0;
  const lat = {
    asr_ms: asrMs, rag_ms: ragMs,
    llm_total_ms: Math.max(0, llmToFirst - ragMs),
    tool_ms: 0, tts_ms: firstSynthMs, buffer_ms: Number($("buffer").value),
  };
  finishTurn(lat, "stream");
}

function finishTurn(lat, mode) {
  // Measured TTFA = ASR (before turnStart) + time from turnStart to first audio.
  const measured = state.firstAudioAt ? state.firstAudioAt - state.turnStart : 0;
  const ttfa = Math.round((lat.asr_ms || 0) + measured);
  const sum = ["asr_ms", "rag_ms", "llm_total_ms", "tool_ms", "tts_ms", "buffer_ms"]
    .reduce((s, k) => s + (lat[k] || 0), 0);
  lat = { ...lat, other_ms: Math.max(0, ttfa - sum) };  // network/decode remainder
  $(mode === "stream" ? "ttfaStream" : "ttfaBatch").textContent = ttfa + "ms";
  renderPie(lat);
  addMetaLine(`[${mode}] TTFA ${ttfa}ms = ASR ${Math.round(lat.asr_ms || 0)} + RAG ${Math.round(lat.rag_ms || 0)} + LLM ${Math.round(lat.llm_total_ms || 0)} + TTS ${Math.round(lat.tts_ms || 0)} + buffer ${Math.round(lat.buffer_ms || 0)} + other ${Math.round(lat.other_ms)}`);
}

// ---- TTS synth + Web Audio queue playback ----
async function synth(text) {
  try {
    const r = await fetch(BASE + "/tts", {
      method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ text, provider: $("tts").value, voice: $("voice").value }),
    });
    if (!r.ok) return null;
    const ms = Number(r.headers.get("X-TTS-Ms") || 0);
    return { audio: await r.arrayBuffer(), ms };
  } catch { return null; }
}

function beginSpeaking() {
  state.playStartTs = performance.now();
  state.bargeFrames = 0;
  setPhase("speaking", "speaking (talk to interrupt)");
}

async function enqueue(arrayBuffer) {
  if (state.cancelled) return;
  let audioBuf;
  try { audioBuf = await state.ac.decodeAudioData(arrayBuffer.slice(0)); }
  catch { return; }
  state.queue.push(audioBuf);
  if (!state.playing) playNext();
}

function playNext() {
  if (state.cancelled) { state.queue = []; state.playing = false; return; }
  const buf = state.queue.shift();
  if (!buf) { state.playing = false; if (state.phase === "speaking") resumeListening(); return; }
  state.playing = true;
  const src = state.ac.createBufferSource();
  src.buffer = buf;
  src.connect(state.ttsAnalyser);
  src.onended = () => { state.source = null; playNext(); };
  state.source = src;
  if (!state.firstAudioAt) { state.firstAudioAt = performance.now(); state.playStartTs = performance.now(); }
  src.start();
}

function stopPlayback() {
  state.cancelled = true;
  state.queue = [];
  if (state.source) { try { state.source.onended = null; state.source.stop(); } catch {} state.source = null; }
  state.playing = false;
}

function bargeIn() {
  stopPlayback();
  if (state.lastBubble) state.lastBubble.classList.add("cancelled");
  fetch(BASE + "/session/cancel_last", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: state.session }),
  }).catch(() => {});
  addMetaLine("- barge-in: response cancelled -");
  resumeListening();
}

function resumeListening() {
  if (!state.on) return;
  state.playing = false;
  setPhase("listening", "listening...");
  if ($("asr").value === "browser") startBrowserASR();
}

// ---- master toggle ----
async function start() {
  try { await ensureMic(); } catch (e) { setPhase("idle", "mic permission denied"); return; }
  if (state.ac.state === "suspended") await state.ac.resume();
  state.on = true;
  setPhase("listening", "calibrating mic...");
  await calibrate();
  setPhase("listening", "listening...");
  if ($("asr").value === "browser") startBrowserASR();
  requestAnimationFrame(loop);
}
function stop() {
  state.on = false;
  stopBrowserASR();
  stopPlayback();
  if (state.recorder && state.recorder.state !== "inactive") try { state.recorder.stop(); } catch {}
  setPhase("idle", "stopped");
}

// ---- load options ----
async function loadModels() {
  try {
    const d = await (await fetch(BASE + "/models")).json();
    $("model").innerHTML = d.models.map((m) => `<option value="${m.key}">${m.label}${m.available ? "" : " (no key)"}</option>`).join("");
  } catch {}
}
let VOICES = {};
async function loadVoices() {
  try {
    const d = await (await fetch(BASE + "/voices")).json();
    $("asr").innerHTML = d.asr.map((a) => `<option value="${a}">${a}</option>`).join("");
    VOICES = d.tts;
    $("tts").innerHTML = Object.keys(d.tts).map((p) => `<option value="${p}">${p}</option>`).join("");
    // product defaults: ElevenLabs for both ASR and TTS
    if (d.asr.includes("elevenlabs")) $("asr").value = "elevenlabs";
    if (d.tts.elevenlabs) $("tts").value = "elevenlabs";
    syncVoices();
  } catch {}
}
function syncVoices() {
  const list = VOICES[$("tts").value] || [];
  $("voice").innerHTML = list.map((v) => `<option value="${v}">${v}</option>`).join("");
}
// Shared agent config consumed by the website widget (merges with playground's).
const CFG_KEY = "nimbus_agent_config";
function persistConfig() {
  const know = document.querySelector("#knowledge .active")?.dataset.v || "ragless";
  const toolsOn = $("toolsEnabled").checked;
  let prev = {};
  try { prev = JSON.parse(localStorage.getItem(CFG_KEY) || "{}"); } catch {}
  const next = {
    ...prev,
    model_key: $("model").value, knowledge: know,
    tools_enabled: toolsOn, enabled_tools: toolsOn ? null : [],
    asr: $("asr").value, tts: $("tts").value, voice: $("voice").value,
    endpoint: Number($("endpoint").value), buffer: Number($("buffer").value),
    barge: $("barge").value,
  };
  localStorage.setItem(CFG_KEY, JSON.stringify(next));
}

function updateAsrHint() {
  $("asrHint").textContent = $("asr").value === "browser"
    ? "On-device Web Speech API. Endpointing handled by the browser."
    : "Server ASR. Your turn ends after the endpoint silence below.";
}

// ---- settings ----
function initSettings() {
  const dlg = $("settings");
  $("settingsBtn").addEventListener("click", () => {
    $("k_openai").value = state.keys.openai || ""; $("k_gemini").value = state.keys.gemini || "";
    $("k_elevenlabs").value = state.keys.elevenlabs || ""; $("apiBase").value = BASE;
    dlg.showModal();
  });
  dlg.addEventListener("close", () => {
    if (dlg.returnValue !== "save") return;
    state.keys = { openai: $("k_openai").value.trim(), gemini: $("k_gemini").value.trim(), elevenlabs: $("k_elevenlabs").value.trim() };
    localStorage.setItem(LS_KEYS, JSON.stringify(state.keys));
    if ($("apiBase").value.trim()) localStorage.setItem(LS_BASE, $("apiBase").value.trim());
  });
}

function init() {
  $("mic").addEventListener("click", () => (state.on ? stop() : start()));
  $("endpoint").addEventListener("input", (e) => $("epVal").textContent = e.target.value);
  $("buffer").addEventListener("input", (e) => $("bufVal").textContent = e.target.value);
  document.querySelectorAll("#mode button").forEach((b) =>
    b.addEventListener("click", () => { document.querySelectorAll("#mode button").forEach((x) => x.classList.remove("active")); b.classList.add("active"); state.mode = b.dataset.v; }));
  $("tts").addEventListener("change", syncVoices);
  $("asr").addEventListener("change", () => { updateAsrHint(); if (state.on) { stopBrowserASR(); resumeListening(); } });
  document.querySelectorAll("#knowledge button").forEach((b) =>
    b.addEventListener("click", () => { document.querySelectorAll("#knowledge button").forEach((x) => x.classList.remove("active")); b.classList.add("active"); }));
  initSettings();
  loadModels(); loadVoices().then(() => { updateAsrHint(); persistConfig(); });
  const cp = document.querySelector(".controls");
  cp.addEventListener("change", persistConfig);
  cp.addEventListener("input", persistConfig);
  document.querySelectorAll("#knowledge button, #mode button").forEach((b) => b.addEventListener("click", persistConfig));
  renderPie({});
}

init();
