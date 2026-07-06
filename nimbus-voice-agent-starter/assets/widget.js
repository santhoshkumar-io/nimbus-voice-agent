// "Talk to Nimbus" - the finalized voice agent embedded on the site.
// Text + voice (mic VAD endpointing -> ASR -> chat -> TTS) with barge-in.
// Reads/writes the shared agent config + keys the Playground also uses (same
// origin localStorage), and mirrors the server cart into the site's `nimbus_cart`.
(function () {
  "use strict";
  var CART_KEY = "nimbus_cart";
  var SID_KEY = "nimbus_widget_session";
  var CFG_KEY = "nimbus_agent_config"; // shared agent settings (Playground writes these too)
  var LS_KEYS = "nimbus_pg_keys";      // API keys, sent per-request as headers
  var LS_BASE = "nimbus_pg_base";      // backend URL override

  // Backend URL: runtime override (settings) -> page default -> localhost.
  function getBase() {
    return (localStorage.getItem(LS_BASE) || window.NIMBUS_API_BASE || "http://localhost:8100").replace(/\/+$/, "");
  }
  // API keys entered in settings are sent as headers; the server falls back to
  // its own env keys when a header is absent.
  function loadKeys() { try { return JSON.parse(localStorage.getItem(LS_KEYS) || "{}"); } catch (e) { return {}; } }
  function authHeaders(withJson) {
    var h = withJson ? { "Content-Type": "application/json" } : {};
    var k = loadKeys();
    if (k.openai) h["X-OpenAI-Key"] = k.openai;
    if (k.gemini) h["X-Gemini-Key"] = k.gemini;
    if (k.elevenlabs) h["X-ElevenLabs-Key"] = k.elevenlabs;
    return h;
  }

  var session = localStorage.getItem(SID_KEY);
  if (!session) { session = "w-" + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(SID_KEY, session); }

  // ---- shared config (written by the Playground / Voice page / this widget) ----
  function cfg() {
    var c = {};
    try { c = JSON.parse(localStorage.getItem(CFG_KEY) || "{}"); } catch (e) {}
    return {
      model_key: c.model_key || "openai-lite",
      response_length: c.response_length || "medium",
      temperature: c.temperature != null ? c.temperature : 0.5,
      system_prompt: c.system_prompt || null,
      knowledge: c.knowledge || "rag",
      top_k: c.top_k || 4, rerank: !!c.rerank,
      verbatim_turns: c.verbatim_turns != null ? c.verbatim_turns : 6,
      tools_enabled: c.tools_enabled !== undefined ? c.tools_enabled : true,
      enabled_tools: c.enabled_tools && c.enabled_tools.length ? c.enabled_tools : null,
      asr: c.asr && c.asr !== "browser" ? c.asr : "elevenlabs",
      asr_language: c.asr_language || "en",
      tts: c.tts || "elevenlabs", voice: c.voice || "Sarah",
      endpoint: c.endpoint || 700, buffer: c.buffer != null ? c.buffer : 120,
      barge: c.barge || "medium",
    };
  }
  function chatBody(message, mode) {
    var c = cfg();
    return JSON.stringify({
      session_id: session, message: message, mode: mode || "batch",
      model_key: c.model_key, response_length: c.response_length,
      use_context: c.knowledge === "ragless", use_rag: c.knowledge === "rag",
      top_k: c.top_k, rerank: c.rerank, verbatim_turns: c.verbatim_turns,
      temperature: c.temperature, system_prompt: c.system_prompt,
      tools_enabled: c.tools_enabled, enabled_tools: c.enabled_tools,
    });
  }

  // ---- styles ----
  var css =
    "#nb-fab{position:fixed;right:20px;bottom:20px;z-index:9999;border:none;cursor:pointer;width:58px;height:58px;border-radius:50%;background:linear-gradient(135deg,#6e8bff,#9d7bff);color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.25);font-size:24px;display:grid;place-items:center}" +
    "#nb-panel{position:fixed;right:20px;bottom:88px;z-index:9999;width:378px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 120px);background:#fff;border:1px solid #e6e8ee;border-radius:16px;box-shadow:0 16px 48px rgba(0,0,0,.22);display:none;flex-direction:column;overflow:hidden;font-family:Inter,system-ui,sans-serif}" +
    "#nb-panel.open{display:flex}" +
    "#nb-head{padding:13px 15px;background:linear-gradient(135deg,#6e8bff,#9d7bff);color:#fff;font-weight:600;font-family:'Space Grotesk',Inter,sans-serif;display:flex;justify-content:space-between;align-items:center}" +
    "#nb-head small{display:block;font-weight:400;opacity:.85;font-size:11px}" +
    "#nb-head .hbtns{display:flex;align-items:center;gap:4px}" +
    "#nb-gear,#nb-x{background:transparent;border:none;color:#fff;font-size:18px;cursor:pointer;line-height:1;padding:2px 4px}" +
    "#nb-settings{position:absolute;inset:54px 0 0 0;background:#fff;z-index:2;padding:14px;overflow-y:auto;display:none;flex-direction:column;gap:10px}" +
    "#nb-settings.open{display:flex}" +
    "#nb-settings h4{margin:0;font-family:'Space Grotesk',Inter,sans-serif;font-size:14px}" +
    "#nb-settings .sec{border-top:1px solid #eef0f4;padding-top:9px;display:flex;flex-direction:column;gap:9px}" +
    "#nb-settings .sec>h5{margin:0;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:#9aa2b4}" +
    "#nb-settings label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#5b6475}" +
    "#nb-settings select,#nb-settings input[type=text],#nb-settings input[type=number],#nb-settings input[type=password],#nb-settings textarea{border:1px solid #d8dce6;border-radius:8px;padding:7px 9px;font:inherit;font-size:13px;color:#1a1f2b;background:#fff}" +
    "#nb-settings textarea{resize:vertical;min-height:52px;line-height:1.4}" +
    "#nb-settings input[type=range]{width:100%;accent-color:#6e8bff}" +
    "#nb-settings .row{display:flex;gap:8px}#nb-settings .row label{flex:1}" +
    "#nb-settings .tg{flex-direction:row;align-items:center;justify-content:space-between}" +
    "#nb-settings .tg input{width:16px;height:16px;accent-color:#6e8bff}" +
    "#nb-settings .hintv{font-size:11px;color:#8b93a7;margin-top:-3px}" +
    "#nb-savecfg{border:none;background:#6e8bff;color:#fff;border-radius:9px;padding:10px;cursor:pointer;font-weight:600;margin-top:2px;position:sticky;bottom:0}" +
    "#nb-settings .pl{font-size:11px;color:#8b93a7}#nb-settings .pl a{color:#6e8bff}" +
    "#nb-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#f7f8fb}" +
    ".nb-m{padding:9px 12px;border-radius:13px;max-width:86%;font-size:14px;line-height:1.45;white-space:pre-wrap}" +
    ".nb-u{align-self:flex-end;background:#6e8bff;color:#fff}" +
    ".nb-a{align-self:flex-start;background:#fff;border:1px solid #e6e8ee;color:#1a1f2b}" +
    ".nb-a.cancelled{opacity:.65}" +
    ".nb-sys{align-self:center;color:#8b93a7;font-size:12px;text-align:center}" +
    ".nb-tools{align-self:flex-start;font-size:11px;color:#6e8bff}" +
    "#nb-status{font-size:11px;color:#8b93a7;padding:3px 14px;background:#f7f8fb;min-height:16px}" +
    "#nb-form{display:flex;gap:7px;padding:10px;border-top:1px solid #eef0f4;background:#fff;align-items:center}" +
    "#nb-mic{border:1px solid #d8dce6;background:#fff;color:#6e8bff;border-radius:10px;width:40px;height:38px;cursor:pointer;display:grid;place-items:center;flex:0 0 auto}" +
    "#nb-mic.on{background:#6e8bff;color:#fff;border-color:#6e8bff}" +
    "#nb-mic.spk{background:#d29922;color:#fff;border-color:#d29922}" +
    "#nb-in{flex:1;border:1px solid #d8dce6;border-radius:10px;padding:9px 11px;font:inherit;font-size:14px;min-width:0}" +
    "#nb-send{border:none;background:#6e8bff;color:#fff;border-radius:10px;padding:0 13px;cursor:pointer;font-weight:600}";
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  var fab = document.createElement("button");
  fab.id = "nb-fab"; fab.title = "Talk to Nimbus"; fab.innerHTML = "&#128172;";
  var panel = document.createElement("div");
  panel.id = "nb-panel";
  panel.innerHTML =
    '<div id="nb-head"><div>Talk to Nimbus<small>Text or voice · full tools</small></div>' +
    '<div class="hbtns"><button id="nb-gear" title="Agent settings">&#9881;</button><button id="nb-x" aria-label="Close">&times;</button></div></div>' +
    '<div id="nb-settings"></div>' +
    '<div id="nb-msgs"><div class="nb-m nb-sys">Ask by typing, or tap the mic to talk. Try "add Nimbus CRM Pro to my cart".</div></div>' +
    '<div id="nb-status"></div>' +
    '<form id="nb-form"><button id="nb-mic" type="button" title="Voice"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"/></svg></button>' +
    '<input id="nb-in" autocomplete="off" placeholder="Ask Nimbus..." /><button id="nb-send" type="submit">Send</button></form>';
  document.body.appendChild(fab); document.body.appendChild(panel);

  var msgs = panel.querySelector("#nb-msgs"), input = panel.querySelector("#nb-in"),
      sendBtn = panel.querySelector("#nb-send"), micBtn = panel.querySelector("#nb-mic"),
      statusEl = panel.querySelector("#nb-status");

  function add(role, text) { var d = document.createElement("div"); d.className = "nb-m nb-" + role; d.textContent = text; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d; }
  function status(t) { statusEl.textContent = t || ""; }
  function toggle(open) { panel.classList.toggle("open", open); if (open) setTimeout(function () { input.focus(); }, 50); }
  fab.addEventListener("click", function () { toggle(!panel.classList.contains("open")); });
  panel.querySelector("#nb-x").addEventListener("click", function () { toggle(false); });

  // ---- exhaustive in-widget settings (mirrors the Playground config surface) ----
  var settingsEl = panel.querySelector("#nb-settings"), gearBtn = panel.querySelector("#nb-gear");
  var VOICEMAP = {};
  function buildSettings() {
    var c = cfg(), k = loadKeys();
    settingsEl.innerHTML =
      '<h4>Agent settings</h4>' +

      '<div class="sec"><h5>Model &amp; generation</h5>' +
        '<label>Model<select id="s-model"></select></label>' +
        '<label>Response length<select id="s-len">' +
          opt(["short", "medium", "long"], c.response_length, { short: "Short", medium: "Medium", long: "Long" }) + '</select></label>' +
        '<label>Temperature <span id="s-tempv" class="hintv"></span>' +
          '<input type="range" id="s-temp" min="0" max="1" step="0.05" value="' + c.temperature + '"></label>' +
        '<label>System prompt (optional)<textarea id="s-sys" placeholder="Override the agent persona / instructions...">' + esc(c.system_prompt || "") + '</textarea></label>' +
      '</div>' +

      '<div class="sec"><h5>Knowledge</h5>' +
        '<label>Mode<select id="s-know">' +
          opt(["rag", "ragless", "none"], c.knowledge, { rag: "RAG (retrieve chunks)", ragless: "Full context (no retrieval)", none: "None (model only)" }) + '</select></label>' +
        '<div class="row"><label>Top-K chunks<input type="number" id="s-topk" min="1" max="20" value="' + c.top_k + '"></label>' +
        '<label class="tg" style="align-self:flex-end;flex:0 0 auto">Rerank<input type="checkbox" id="s-rerank"' + (c.rerank ? " checked" : "") + '></label></div>' +
        '<div class="hintv">Top-K &amp; rerank apply only in RAG mode.</div>' +
      '</div>' +

      '<div class="sec"><h5>Memory &amp; tools</h5>' +
        '<label>Verbatim turns kept<input type="number" id="s-verb" min="0" max="30" value="' + c.verbatim_turns + '"></label>' +
        '<label class="tg">Tools (cart, pricing, sorting...)<input type="checkbox" id="s-tools"' + (c.tools_enabled ? " checked" : "") + '></label>' +
      '</div>' +

      '<div class="sec"><h5>Speech in (ASR)</h5>' +
        '<label>Provider<select id="s-asr">' + opt(["openai", "gemini", "elevenlabs"], c.asr) + '</select></label>' +
        '<label>Recognition language<select id="s-asrlang">' +
          opt(["en", "auto", "ta", "hi", "te", "ml", "kn", "es", "fr", "de", "ja", "zh", "ar", "pt", "ru"], c.asr_language,
            { en: "English", auto: "Auto-detect", ta: "Tamil", hi: "Hindi", te: "Telugu", ml: "Malayalam", kn: "Kannada", es: "Spanish", fr: "French", de: "German", ja: "Japanese", zh: "Chinese", ar: "Arabic", pt: "Portuguese", ru: "Russian" }) + '</select></label>' +
        '<div class="hintv">Pin a language so short/accented speech is not misdetected. Auto-detect lets the provider guess.</div>' +
        '<label>End-of-speech silence (ms)<input type="number" id="s-endpoint" min="200" max="3000" step="50" value="' + c.endpoint + '"></label>' +
      '</div>' +

      '<div class="sec"><h5>Speech out (TTS)</h5>' +
        '<div class="row"><label>Provider<select id="s-tts">' + opt(["openai", "gemini", "elevenlabs"], c.tts) + '</select></label>' +
        '<label>Voice<select id="s-voice"></select></label></div>' +
        '<label>Playback buffer (ms)<input type="number" id="s-buffer" min="0" max="800" step="10" value="' + c.buffer + '"></label>' +
        '<label>Barge-in (interrupt)<select id="s-barge">' +
          opt(["off", "low", "medium", "high"], c.barge, { off: "Off", low: "Low sensitivity", medium: "Medium sensitivity", high: "High sensitivity" }) + '</select></label>' +
      '</div>' +

      '<div class="sec"><h5>Connection &amp; API keys</h5>' +
        '<label>Backend URL<input type="text" id="s-base" placeholder="http://localhost:8100" value="' + esc(localStorage.getItem(LS_BASE) || window.NIMBUS_API_BASE || "") + '"></label>' +
        '<label>OpenAI key<input type="password" id="s-koa" placeholder="sk-..." value="' + esc(k.openai || "") + '"></label>' +
        '<label>Gemini key<input type="password" id="s-kge" placeholder="AIza..." value="' + esc(k.gemini || "") + '"></label>' +
        '<label>ElevenLabs key<input type="password" id="s-kel" placeholder="..." value="' + esc(k.elevenlabs || "") + '"></label>' +
        '<div class="hintv">Stored only in this browser and sent per request. Blank = use the server\'s own keys.</div>' +
      '</div>' +

      '<button id="nb-savecfg">Save settings</button>' +
      '<div class="pl">Open the full <a href="playground/voice.html">Voice agent &#8599;</a></div>';

    // temperature live readout
    var tSlider = settingsEl.querySelector("#s-temp"), tOut = settingsEl.querySelector("#s-tempv");
    var showTemp = function () { tOut.textContent = Number(tSlider.value).toFixed(2); };
    tSlider.addEventListener("input", showTemp); showTemp();

    // models (keyed to current backend + keys)
    fetch(getBase() + "/models", { headers: authHeaders(false) }).then(function (r) { return r.json(); }).then(function (d) {
      settingsEl.querySelector("#s-model").innerHTML = (d.models || []).map(function (m) {
        return '<option value="' + m.key + '"' + (m.key === c.model_key ? " selected" : "") + '>' + m.label + (m.available ? "" : " (no key)") + '</option>';
      }).join("");
    }).catch(function () {});
    // voices depend on TTS provider
    fetch(getBase() + "/voices", { headers: authHeaders(false) }).then(function (r) { return r.json(); }).then(function (d) {
      VOICEMAP = d.tts || {}; syncVoiceSel(c.voice);
    }).catch(function () {});
    settingsEl.querySelector("#s-tts").addEventListener("change", function () { syncVoiceSel(); });
    settingsEl.querySelector("#nb-savecfg").addEventListener("click", saveSettings);
  }
  function opt(vals, sel, labels) {
    return vals.map(function (v) { return '<option value="' + v + '"' + (v === sel ? " selected" : "") + '>' + ((labels && labels[v]) || v) + '</option>'; }).join("");
  }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function syncVoiceSel(want) {
    var prov = settingsEl.querySelector("#s-tts").value, list = VOICEMAP[prov] || [];
    settingsEl.querySelector("#s-voice").innerHTML = opt(list, want || list[0]);
  }
  function num(sel, dflt) { var n = parseFloat(val(sel)); return isNaN(n) ? dflt : n; }
  function saveSettings() {
    var prev = {}; try { prev = JSON.parse(localStorage.getItem(CFG_KEY) || "{}"); } catch (e) {}
    var sys = val("#s-sys").trim();
    var next = Object.assign({}, prev, {
      model_key: val("#s-model"), response_length: val("#s-len"),
      temperature: num("#s-temp", 0.5), system_prompt: sys || null,
      knowledge: val("#s-know"), top_k: num("#s-topk", 4), rerank: settingsEl.querySelector("#s-rerank").checked,
      verbatim_turns: num("#s-verb", 6), tools_enabled: settingsEl.querySelector("#s-tools").checked,
      asr: val("#s-asr"), asr_language: val("#s-asrlang"), endpoint: num("#s-endpoint", 700),
      tts: val("#s-tts"), voice: val("#s-voice"), buffer: num("#s-buffer", 120), barge: val("#s-barge"),
    });
    localStorage.setItem(CFG_KEY, JSON.stringify(next));

    // connection + keys
    var base = val("#s-base").trim();
    if (base) localStorage.setItem(LS_BASE, base.replace(/\/+$/, "")); else localStorage.removeItem(LS_BASE);
    var keys = { openai: val("#s-koa").trim(), gemini: val("#s-kge").trim(), elevenlabs: val("#s-kel").trim() };
    localStorage.setItem(LS_KEYS, JSON.stringify(keys));

    settingsEl.classList.remove("open");
    add("sys", "Settings saved.");
  }
  function val(sel) { return settingsEl.querySelector(sel).value; }
  gearBtn.addEventListener("click", function () {
    if (settingsEl.classList.contains("open")) { settingsEl.classList.remove("open"); return; }
    buildSettings(); settingsEl.classList.add("open");
  });

  // ---- cart bridge ----
  function syncCart() {
    fetch(getBase() + "/cart?session_id=" + encodeURIComponent(session), { headers: authHeaders(false) }).then(function (r) { return r.json(); })
      .then(function (d) {
        var items = (d.items || []).map(function (i) { return { product_id: i.product_id, product_name: i.product_name, tier: i.tier, seats: i.seats, price: i.price_monthly }; });
        localStorage.setItem(CART_KEY, JSON.stringify(items));
        window.dispatchEvent(new Event("nimbus:cart-refresh"));
      }).catch(function () {});
  }

  // ---- chat turn (shared by text + voice) ----
  function chatTurn(message, onText) {
    var bubble = add("a", "...");
    return fetch(getBase() + "/chat", { method: "POST", headers: authHeaders(true), body: chatBody(message) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { bubble.textContent = "Sorry, " + d.error; return null; }
        bubble.textContent = d.text;
        var calls = (d.meta && d.meta.tool_calls) || [];
        if (calls.length) { var t = add("tools", "ran: " + calls.map(function (c) { return c.name; }).join(", ")); syncCart(); }
        if (onText) onText(d.text, bubble);
        return d;
      })
      .catch(function (e) { bubble.textContent = "Connection error: " + e.message; return null; });
  }

  // text send
  panel.querySelector("#nb-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = input.value.trim(); if (!v) return; input.value = "";
    add("u", v); sendBtn.disabled = true; input.disabled = true;
    chatTurn(v).finally(function () { sendBtn.disabled = false; input.disabled = false; input.focus(); });
  });

  // ============ VOICE ============
  var V = { on: false, phase: "idle", stream: null, ac: null, an: null, buf: null,
            ttsAn: null, ttsBuf: null, rec: null, chunks: [], lastVoice: 0, noise: 0.01,
            queue: [], src: null, playing: false, cancelled: false,
            echoGain: 0.4, bargeFrames: 0, playTs: 0 };
  var BARGE_GRACE = 140; // let echo coupling converge before judging interruptions
  var START_FRAMES = 3;  // sustained frames of voice before we start recording (rejects taps)
  var BARGE_PRESETS = { off: { en: false, th: 1, fr: 999 }, low: { en: true, th: 0.06, fr: 7 }, medium: { en: true, th: 0.045, fr: 5 }, high: { en: true, th: 0.032, fr: 4 } };
  function bargeP() { return BARGE_PRESETS[cfg().barge] || BARGE_PRESETS.medium; }

  function rmsOf(an, b) { an.getFloatTimeDomainData(b); var s = 0; for (var i = 0; i < b.length; i++) s += b[i] * b[i]; return Math.sqrt(s / b.length); }
  function mic() { return rmsOf(V.an, V.buf); }
  function ttsLvl() { return V.playing ? rmsOf(V.ttsAn, V.ttsBuf) : 0; }
  function thr() { return Math.max(0.02, V.noise * 2.5 + 0.012); }
  // A transcript is real speech only if it has >=2 letters after removing
  // bracketed audio-event tags like "(footsteps)" or "[laughter]".
  function isSpeech(t) {
    var w = (t || "").replace(/[\(\[\{\*][^\)\]\}\*]*[\)\]\}\*]/g, "").replace(/[^A-Za-z0-9À-ɏऀ-෿]+/g, "");
    return w.length >= 2;
  }

  function setMic(cls, txt) { micBtn.className = cls; if (txt !== undefined) status(txt); }

  async function ensureMic() {
    if (V.stream) return;
    V.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    V.ac = new (window.AudioContext || window.webkitAudioContext)();
    var s = V.ac.createMediaStreamSource(V.stream);
    V.an = V.ac.createAnalyser(); V.an.fftSize = 1024; V.buf = new Float32Array(V.an.fftSize); s.connect(V.an);
    V.ttsAn = V.ac.createAnalyser(); V.ttsAn.fftSize = 1024; V.ttsBuf = new Float32Array(V.ttsAn.fftSize); V.ttsAn.connect(V.ac.destination);
  }
  async function calibrate() { var a = [], t = performance.now(); while (performance.now() - t < 450) { a.push(mic()); await new Promise(function (r) { setTimeout(r, 30); }); } V.noise = a.reduce(function (x, y) { return x + y; }, 0) / a.length; }

  function loop() {
    if (!V.on) return;
    var lvl = mic(), now = performance.now(), th = thr();
    if (V.phase === "speaking") {
      var bp = bargeP(), out = ttsLvl(), residual = lvl - V.echoGain * out;
      var speaking = residual > bp.th;
      if (!speaking && out > 0.005) V.echoGain = Math.min(4, Math.max(0, V.echoGain * 0.97 + (lvl / out) * 0.03));
      if (bp.en && now - V.playTs > BARGE_GRACE) {
        // Require sustained speech-band energy: a single loud transient (tap,
        // footstep) is too brief to accumulate frames, and dips decay quickly.
        V.bargeFrames = speaking ? V.bargeFrames + 1 : Math.max(0, V.bargeFrames - 2);
        if (V.bargeFrames >= bp.fr) bargeIn();
      }
    } else if (V.phase === "listening") {
      if (lvl > th) { V.listenFrames = (V.listenFrames || 0) + 1; if (V.listenFrames >= START_FRAMES) { V.listenFrames = 0; beginRec(); } }
      else { V.listenFrames = Math.max(0, (V.listenFrames || 0) - 1); }
    } else if (V.phase === "recording") { if (lvl > th) V.lastVoice = now; if (now - V.lastVoice > cfg().endpoint) endRec(); }
    requestAnimationFrame(loop);
  }

  function pickMime() { var ms = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]; for (var i = 0; i < ms.length; i++) if (MediaRecorder.isTypeSupported(ms[i])) return ms[i]; return ""; }
  function beginRec() {
    V.chunks = []; V.rec = new MediaRecorder(V.stream, { mimeType: pickMime() });
    V.rec.ondataavailable = function (e) { if (e.data.size) V.chunks.push(e.data); };
    V.rec.onstop = onRec; V.rec.start(); V.lastVoice = performance.now();
    V.phase = "recording"; setMic("on", "listening...");
  }
  function endRec() { if (V.rec && V.rec.state !== "inactive") V.rec.stop(); }
  async function onRec() {
    var blob = new Blob(V.chunks, { type: V.rec.mimeType });
    if (blob.size < 1200) { V.phase = "listening"; status("listening..."); return; }
    V.phase = "thinking"; setMic("on", "transcribing...");
    var fd = new FormData(); fd.append("provider", cfg().asr); fd.append("language", cfg().asr_language); fd.append("file", blob, "u.webm");
    try {
      var d = await (await fetch(getBase() + "/asr", { method: "POST", headers: authHeaders(false), body: fd })).json();
      if (d.error) { V.phase = "listening"; status("ASR: " + d.error); return; }
      var said = (d.text || "").trim();
      if (!isSpeech(said)) { V.phase = "listening"; status("listening..."); return; } // ignored: background noise
      add("u", said);
      var chat = await chatTurn(said);
      if (chat) await speak(chat.text); else resume();
    } catch (e) { V.phase = "listening"; status("error: " + e.message); }
  }

  // TTS via Web Audio + double-talk barge
  async function speak(text) {
    V.cancelled = false; V.phase = "thinking"; setMic("spk", "speaking...");
    var c = cfg(), ab, ttsMs = 0;
    try {
      var r = await fetch(getBase() + "/tts", { method: "POST", headers: authHeaders(true), body: JSON.stringify({ text: text, provider: c.tts, voice: c.voice }) });
      if (!r.ok) { resume(); return; }
      ttsMs = Number(r.headers.get("X-TTS-Ms") || 0); ab = await r.arrayBuffer();
    } catch (e) { resume(); return; }
    await new Promise(function (res) { setTimeout(res, c.buffer); });
    if (V.cancelled) return;
    V.phase = "speaking"; V.playTs = performance.now(); V.bargeFrames = 0;
    enqueue(ab);
  }
  async function enqueue(ab) {
    if (V.cancelled) return;
    var b; try { b = await V.ac.decodeAudioData(ab.slice(0)); } catch (e) { return; }
    V.queue.push(b); if (!V.playing) playNext();
  }
  function playNext() {
    if (V.cancelled) { V.queue = []; V.playing = false; return; }
    var b = V.queue.shift();
    if (!b) { V.playing = false; if (V.phase === "speaking") resume(); return; }
    V.playing = true; var s = V.ac.createBufferSource(); s.buffer = b; s.connect(V.ttsAn);
    s.onended = function () { V.src = null; playNext(); }; V.src = s;
    if (!V.playTs) V.playTs = performance.now(); s.start();
  }
  function stopAudio() { V.cancelled = true; V.queue = []; if (V.src) { try { V.src.onended = null; V.src.stop(); } catch (e) {} V.src = null; } V.playing = false; }
  function bargeIn() {
    stopAudio();
    var last = msgs.querySelectorAll(".nb-a"); if (last.length) last[last.length - 1].classList.add("cancelled");
    fetch(getBase() + "/session/cancel_last", { method: "POST", headers: authHeaders(true), body: JSON.stringify({ session_id: session }) }).catch(function () {});
    resume();
  }
  function resume() { if (!V.on) { setMic("", ""); return; } V.playing = false; V.phase = "listening"; setMic("on", "listening..."); }

  async function startVoice() {
    try { await ensureMic(); } catch (e) { status("mic permission denied"); return; }
    if (V.ac.state === "suspended") await V.ac.resume();
    V.on = true; V.phase = "listening"; setMic("on", "calibrating...");
    await calibrate(); status("listening..."); requestAnimationFrame(loop);
  }
  function stopVoice() { V.on = false; stopAudio(); if (V.rec && V.rec.state !== "inactive") try { V.rec.stop(); } catch (e) {} V.phase = "idle"; setMic("", ""); }
  micBtn.addEventListener("click", function () { V.on ? stopVoice() : startVoice(); });
})();
