// Nimbus voice agent - Phase 4.
// Turn-based loop: mic -> VAD endpointing -> ASR -> /chat -> TTS -> buffered
// playback, with barge-in and a combined per-stage latency pie.

const LS_KEYS = "nimbus_pg_keys";
const LS_BASE = "nimbus_pg_base";
const BASE = localStorage.getItem(LS_BASE) || window.NIMBUS_API_BASE || "http://localhost:8100";
const $ = (id) => document.getElementById(id);

const PIE = {
  asr_ms: ["ASR", "#3fb0c9"], rag_ms: ["RAG", "#9d7bff"], llm_total_ms: ["LLM", "#6e8bff"],
  tool_llm_ms: ["Tool call (LLM round-trip)", "#3fb950"], tool_ms: ["Tool exec", "#2ea043"],
  tts_ms: ["TTS", "#d29922"], buffer_ms: ["Buffer", "#e06aa8"],
  other_ms: ["Other/net", "#8b93a7"],
};
// The tool round-trip time lives inside llm_total; split it out so "LLM" shows
// pure generation and "Tool call" shows the extra round-trip a tool triggered.
function splitToolLatency(lat) {
  const d = { ...lat };
  d.llm_total_ms = Math.max(0, (lat.llm_total_ms || 0) - (lat.tool_llm_ms || 0));
  return d;
}

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
  shortAnswers: true, fastTTS: false,  // latency-lab flags
  speakingTurn: false,  // true while a streamed turn is still producing sentences
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
  if (state.keys.deepgram) h["X-Deepgram-Key"] = state.keys.deepgram;
  if (state.keys.cartesia) h["X-Cartesia-Key"] = state.keys.cartesia;
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
function renderPie(rawLat) {
  const lat = splitToolLatency(rawLat);
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

// ---- noise cancellation (mic) ----
// Quail (LiveKit's canceller) is not available outside LiveKit, so we do it in
// the browser: built-in constraints, plus an optional free RNNoise worklet.
const NOISE_ASSETS = "assets/noise";
const LS_NOISE = "nimbus_pg_noise";
function noiseMode() {
  const sel = $("noise"); return (sel && sel.value) || localStorage.getItem(LS_NOISE) || "builtin";
}
function micConstraints(mode) {
  if (mode === "off") return { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  // RNNoise/Krisp do the suppression themselves; keep echo cancel, drop browser NS/AGC.
  if (mode === "rnnoise" || mode === "krisp") return { echoCancellation: true, noiseSuppression: false, autoGainControl: false };
  return { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
}
// Route a raw mic stream through RNNoise; returns a cleaned MediaStream. Any
// failure (asset missing, unsupported) falls back to the raw stream.
async function applyRnnoise(rawStream, ac) {
  try {
    const mod = await import(`${NOISE_ASSETS}/index.js`);
    await ac.audioWorklet.addModule(`${NOISE_ASSETS}/rnnoiseWorklet.js`);
    const wasmBinary = await mod.loadRnnoise({
      url: `${NOISE_ASSETS}/rnnoise.wasm`, simdUrl: `${NOISE_ASSETS}/rnnoise_simd.wasm`,
    });
    const node = new mod.RnnoiseWorkletNode(ac, { maxChannels: 1, wasmBinary });
    const src = ac.createMediaStreamSource(rawStream);
    const dest = ac.createMediaStreamDestination();
    src.connect(node).connect(dest);
    state.rnnoise = node;
    return dest.stream;
  } catch (e) {
    setNoiseHint(`RNNoise unavailable, using built-in (${String(e).slice(0, 60)})`);
    return rawStream;
  }
}

// Krisp is the licensed engine behind LiveKit's "Quail". Its Web SDK is gated,
// so we can't bundle it; instead we load an adapter you drop in at
// assets/krisp/index.js exporting createKrispStream(rawStream, ac, key) ->
// { stream, controller? }. See assets/krisp/README.md. Falls back to built-in.
const KRISP_ASSETS = "assets/krisp";
async function applyKrisp(rawStream, ac) {
  try {
    const mod = await import(`${KRISP_ASSETS}/index.js`);
    if (typeof mod.createKrispStream !== "function") {
      throw new Error("adapter missing createKrispStream export");
    }
    const out = await mod.createKrispStream(rawStream, ac, (state.keys && state.keys.krisp) || "");
    state.krisp = out.controller || null;
    return out.stream || rawStream;
  } catch (e) {
    setNoiseHint(`Krisp not configured, using built-in. Add credentials per assets/krisp/README.md (${String(e).slice(0, 60)})`);
    return rawStream;
  }
}

function setNoiseHint(t) { const el = $("noiseHint"); if (el) el.textContent = t; }
function updateNoiseHint() {
  const m = noiseMode();
  setNoiseHint(m === "rnnoise"
    ? "Echo-cancel + free RNNoise worklet (Quail-style, on-device). First use loads a small model."
    : m === "krisp"
    ? "Krisp (the engine behind LiveKit's Quail). Needs the Krisp SDK in assets/krisp/ + a key; see README."
    : m === "off" ? "Raw mic, no processing."
    : "Browser built-in noise suppression + echo cancellation.");
}
// Release the mic + audio graph so a new noise mode is picked up on next start.
function releaseMic() {
  try { if (state.rnnoise && state.rnnoise.destroy) state.rnnoise.destroy(); } catch {}
  try { if (state.krisp && state.krisp.destroy) state.krisp.destroy(); } catch {}
  state.rnnoise = null; state.krisp = null;
  for (const s of [state.rawStream, state.stream]) {
    try { s && s.getTracks().forEach((t) => t.stop()); } catch {}
  }
  try { if (state.ac && state.ac.state !== "closed") state.ac.close(); } catch {}
  state.stream = null; state.rawStream = null; state.ac = null;
  state.analyser = null; state.ttsAnalyser = null;
}

// ---- mic + analyser ----
async function ensureMic() {
  if (state.stream) return;
  const mode = noiseMode();
  const raw = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(mode) });
  state.rawStream = raw;
  state.ac = new (window.AudioContext || window.webkitAudioContext)();
  state.stream = mode === "rnnoise" ? await applyRnnoise(raw, state.ac)
    : mode === "krisp" ? await applyKrisp(raw, state.ac) : raw;
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
    if (bc.enabled && since > BARGE_GRACE_MS && state.playing) {
      // Require sustained speech-band energy; a single loud transient (tap,
      // footstep) is too brief to accumulate frames, and dips decay quickly.
      // Only count while audio is actually playing: during the gap between
      // streamed sentences there is nothing to interrupt, and the echo tail
      // would otherwise be misread as the user talking.
      state.bargeFrames = speaking ? state.bargeFrames + 1 : Math.max(0, state.bargeFrames - 2);
      if (state.bargeFrames >= bc.frames) bargeIn();
    } else if (!state.playing) {
      state.bargeFrames = Math.max(0, state.bargeFrames - 1);
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
  state.speechEndTs = 0;  // fresh recognizer: no end-of-speech mark yet for this turn
  rec.onspeechend = () => { state.speechEndTs = performance.now(); };
  rec.onresult = async (ev) => {
    const text = ev.results[ev.results.length - 1][0].transcript.trim();
    if (!isSpeech(text) || state.phase === "thinking" || state.phase === "speaking") return;
    addMsg("user", text);
    // Time from end-of-speech to transcript. onspeechend does not always fire before
    // onresult after a restart, so a leftover speechEndTs from a previous turn would
    // otherwise inflate this to many seconds. Consume it and ignore implausible values.
    const dt = state.speechEndTs ? Math.round(performance.now() - state.speechEndTs) : 0;
    state.speechEndTs = 0;  // consume so it cannot leak into the next turn
    const asrMs = dt >= 0 && dt <= 4000 ? dt : 0;  // browser ASR is near-instant
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
    model_key: $("model").value, response_length: state.shortAnswers ? "low" : "high",
    use_context: know === "ragless", use_rag: know === "rag", top_k: 4,
    tools_enabled: $("toolsEnabled").checked,
    enabled_tools: $("toolsEnabled").checked ? null : [],
  });
}

async function runPipeline(userText, asrMs) {
  state.cancelled = false;
  state.speakingTurn = false;
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
    if (!spoke) { spoke = true; state.speakingTurn = true; beginSpeaking(); await new Promise((r) => setTimeout(r, Number($("buffer").value))); }
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
  // Stream is fully produced: allow the turn to end once playback drains.
  state.speakingTurn = false;
  if (state.phase === "speaking" && !state.playing && state.queue.length === 0) resumeListening();
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
    const provider = $("tts").value;
    // Cartesia is voice-id driven; use the id pasted in settings, not the dropdown label.
    const voice = provider === "cartesia" ? (state.keys.cartesia_voice || "") : $("voice").value;
    const r = await fetch(BASE + "/tts", {
      method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ text, provider, voice, fast: state.fastTTS }),
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
  if (!buf) {
    state.playing = false;
    // Only end the turn if no more sentences are still being streamed in.
    // Mid-stream drains (first sentence done before the next is synthesized)
    // must NOT resume listening, or we cut our own response off.
    if (state.phase === "speaking" && !state.speakingTurn) resumeListening();
    return;
  }
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
  state.speakingTurn = false;
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
    $("k_deepgram").value = state.keys.deepgram || "";
    $("k_cartesia").value = state.keys.cartesia || ""; $("k_cartesia_voice").value = state.keys.cartesia_voice || "";
    $("k_krisp").value = state.keys.krisp || "";
    dlg.showModal();
  });
  dlg.addEventListener("close", () => {
    if (dlg.returnValue !== "save") return;
    state.keys = {
      openai: $("k_openai").value.trim(), gemini: $("k_gemini").value.trim(),
      elevenlabs: $("k_elevenlabs").value.trim(),
      deepgram: $("k_deepgram").value.trim(), cartesia: $("k_cartesia").value.trim(),
      cartesia_voice: $("k_cartesia_voice").value.trim(), krisp: $("k_krisp").value.trim(),
    };
    localStorage.setItem(LS_KEYS, JSON.stringify(state.keys));
    if ($("apiBase").value.trim()) localStorage.setItem(LS_BASE, $("apiBase").value.trim());
  });
}

// ---- speech-to-speech (Gemini Live) pipeline ----
let s2s = null;
function pipelineMode() { return ($("pipeline") && $("pipeline").value) || "cascade"; }
function applyPipelineUI() {
  const s2s = pipelineMode() === "s2s";
  document.querySelectorAll(".cascade-only").forEach((el) => { el.style.display = s2s ? "none" : ""; });
  const hint = $("s2sHint"); if (hint) hint.style.display = s2s ? "" : "none";
}
function s2sBase() { return localStorage.getItem(LS_BASE) || window.NIMBUS_API_BASE || "http://localhost:8100"; }

function startS2S() {
  const know = document.querySelector("#knowledge .active").dataset.v;
  s2s = window.NimbusS2S(s2sBase, () => state.keys);
  state.on = true;
  setPhase("listening", "connecting to speech-to-speech...");
  s2s.start(
    { session_id: state.session, knowledge: know, tools_enabled: $("toolsEnabled").checked,
      response_length: "low", model_key: $("model").value },
    {
      onStatus: (t) => setPhase(t === "listening" ? "listening" : t === "idle" ? "idle" : "thinking", t),
      onTurn: (u, a) => { if (u) addMsg("user", u); if (a) addMsg("assistant", a); },
      onTool: (names) => { addMetaLine("- tools: " + names.join(", ") + " -"); },
      onLatency: (ms) => { addMetaLine("- time-to-first-audio: " + Math.round(ms) + " ms -"); renderPie({ llm_total_ms: ms }); },
      onError: (e) => { setPhase("idle", "S2S error: " + e); },
    }
  );
}
function stopS2S() { state.on = false; if (s2s) { s2s.stop(); s2s = null; } setPhase("idle", "stopped"); }

function micToggle() {
  if (pipelineMode() === "s2s") return state.on ? stopS2S() : startS2S();
  return state.on ? stop() : start();
}

// ---- Latency lab: switches that drive the cascade controls (ON = lower latency) ----
const LAT_SWITCHES = [
  { id: "stream", t: "Streaming", d: "overlap LLM + TTS",
    read: () => state.mode === "stream",
    set: (v) => document.querySelector(`#mode button[data-v="${v ? "stream" : "batch"}"]`).click() },
  { id: "short", t: "Short answers", d: "fewer tokens to speak",
    read: () => state.shortAnswers, set: (v) => { state.shortAnswers = v; } },
  { id: "fastmodel", t: "Fast model", d: "Gemini Flash vs Pro",
    read: () => $("model").value === "gemini-flash",
    set: (v) => { $("model").value = v ? "gemini-flash" : "gemini-pro"; $("model").dispatchEvent(new Event("change")); } },
  { id: "rag", t: "Lean prompt (RAG)", d: "small retrieved context",
    read: () => document.querySelector("#knowledge .active")?.dataset.v === "rag",
    set: (v) => document.querySelector(`#knowledge button[data-v="${v ? "rag" : "ragless"}"]`).click() },
  { id: "fasttts", t: "Flash TTS", d: "ElevenLabs Flash v2.5",
    read: () => state.fastTTS,
    set: (v) => { state.fastTTS = v; if (v) { $("tts").value = "elevenlabs"; $("tts").dispatchEvent(new Event("change")); } } },
  { id: "localasr", t: "Local ASR", d: "browser, no upload",
    read: () => $("asr").value === "browser",
    set: (v) => { $("asr").value = v ? "browser" : "elevenlabs"; $("asr").dispatchEvent(new Event("change")); } },
  { id: "endpoint", t: "Snappy endpointing", d: "end the turn faster",
    read: () => Number($("endpoint").value) <= 400,
    set: (v) => { $("endpoint").value = v ? 300 : 700; $("endpoint").dispatchEvent(new Event("input")); } },
  { id: "buffer", t: "Tiny pre-buffer", d: "start audio sooner",
    read: () => Number($("buffer").value) === 0,
    set: (v) => { $("buffer").value = v ? 0 : 150; $("buffer").dispatchEvent(new Event("input")); } },
];

function syncLatMaster() {
  const m = $("latMaster");
  if (m) m.checked = LAT_SWITCHES.every((s) => s.read());
}

function initLatLab() {
  const host = $("latSwitches");
  if (!host) return;
  host.innerHTML = LAT_SWITCHES.map((s) =>
    `<label class="latsw"><span><span class="lsw-t">${s.t}</span><br><span class="lsw-d">${s.d}</span></span>` +
    `<input type="checkbox" data-id="${s.id}" /></label>`).join("");
  LAT_SWITCHES.forEach((s) => {
    const cb = host.querySelector(`input[data-id="${s.id}"]`);
    cb.checked = s.read();
    cb.addEventListener("change", () => { s.set(cb.checked); syncLatMaster(); persistConfig(); });
  });
  $("latMaster").addEventListener("change", () => {
    const v = $("latMaster").checked;
    LAT_SWITCHES.forEach((s) => {
      s.set(v);
      host.querySelector(`input[data-id="${s.id}"]`).checked = v;
    });
    persistConfig();
  });
  syncLatMaster();
}

function init() {
  $("mic").addEventListener("click", micToggle);
  if ($("pipeline")) $("pipeline").addEventListener("change", () => { if (state.on) micToggle(); applyPipelineUI(); });
  applyPipelineUI();
  $("endpoint").addEventListener("input", (e) => $("epVal").textContent = e.target.value);
  $("buffer").addEventListener("input", (e) => $("bufVal").textContent = e.target.value);
  document.querySelectorAll("#mode button").forEach((b) =>
    b.addEventListener("click", () => { document.querySelectorAll("#mode button").forEach((x) => x.classList.remove("active")); b.classList.add("active"); state.mode = b.dataset.v; }));
  $("tts").addEventListener("change", syncVoices);
  $("asr").addEventListener("change", () => { updateAsrHint(); if (state.on) { stopBrowserASR(); resumeListening(); } });
  if ($("noise")) {
    const saved = localStorage.getItem(LS_NOISE); if (saved) $("noise").value = saved;
    updateNoiseHint();
    $("noise").addEventListener("change", () => {
      localStorage.setItem(LS_NOISE, $("noise").value);
      updateNoiseHint();
      const wasOn = state.on;
      if (wasOn) stop();
      releaseMic();
      if (wasOn) start();
    });
  }
  document.querySelectorAll("#knowledge button").forEach((b) =>
    b.addEventListener("click", () => { document.querySelectorAll("#knowledge button").forEach((x) => x.classList.remove("active")); b.classList.add("active"); }));
  initSettings();
  loadModels(); loadVoices().then(() => { updateAsrHint(); initLatLab(); persistConfig(); });
  const cp = document.querySelector(".controls");
  cp.addEventListener("change", persistConfig);
  cp.addEventListener("input", persistConfig);
  document.querySelectorAll("#knowledge button, #mode button").forEach((b) => b.addEventListener("click", persistConfig));
  renderPie({});
}

init();
