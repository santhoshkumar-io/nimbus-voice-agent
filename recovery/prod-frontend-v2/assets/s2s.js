// Speech-to-speech client engine (Gemini Live via the backend /live WebSocket).
// Captures mic as 16 kHz PCM16, streams it up, plays back 24 kHz PCM16, and
// surfaces transcripts / tool calls / latency / barge-in via callbacks.
// Usage: const s2s = NimbusS2S(base, keys); s2s.start(initCfg, callbacks); s2s.stop();
window.NimbusS2S = function (getBase, getKeys) {
  const IN_RATE = 16000, OUT_RATE = 24000;
  let ws = null, micCtx = null, playCtx = null, stream = null, proc = null;
  let playHead = 0, sources = [], running = false, cbs = {}, dropUntil = 0;

  function wsURL() {
    const base = getBase().replace(/^http/, "ws").replace(/\/+$/, "");
    return base + "/live";
  }

  function floatTo16(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function play(int16) {
    if (!playCtx) return;
    const f = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f[i] = int16[i] / 32768;
    const buf = playCtx.createBuffer(1, f.length, OUT_RATE);
    buf.getChannelData(0).set(f);
    const src = playCtx.createBufferSource();
    src.buffer = buf; src.connect(playCtx.destination);
    const now = playCtx.currentTime;
    if (playHead < now) playHead = now;
    src.start(playHead); playHead += buf.duration;
    sources.push(src);
    src.onended = () => { sources = sources.filter((s) => s !== src); };
  }

  function flushPlayback() {
    sources.forEach((s) => { try { s.stop(); } catch (e) {} });
    sources = []; playHead = playCtx ? playCtx.currentTime : 0;
  }

  async function start(init, callbacks) {
    cbs = callbacks || {};
    running = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) { cbs.onError && cbs.onError("mic permission denied"); return stop(); }

    micCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: IN_RATE });
    playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: OUT_RATE });
    if (micCtx.state === "suspended") await micCtx.resume();
    if (playCtx.state === "suspended") await playCtx.resume();

    ws = new WebSocket(wsURL());
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      ws.send(JSON.stringify(Object.assign({ keys: getKeys() }, init)));
      cbs.onStatus && cbs.onStatus("connecting...");
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        if (Date.now() < dropUntil) return; // discard in-flight audio from an interrupted turn
        play(new Int16Array(ev.data)); return;
      }
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === "ready") { cbs.onStatus && cbs.onStatus("listening"); beginCapture(); }
      else if (m.type === "tool") cbs.onTool && cbs.onTool(m.names);
      else if (m.type === "latency") cbs.onLatency && cbs.onLatency(m.ttfa_ms);
      else if (m.type === "turn") cbs.onTurn && cbs.onTurn(m.user, m.assistant);
      else if (m.type === "interrupted") { dropUntil = Date.now() + 250; flushPlayback(); cbs.onStatus && cbs.onStatus("listening"); }
      else if (m.type === "error") { cbs.onError && cbs.onError(m.error); }
    };
    ws.onclose = () => { if (running) cbs.onStatus && cbs.onStatus("disconnected"); };
    ws.onerror = () => { cbs.onError && cbs.onError("connection error"); };
  }

  function beginCapture() {
    const srcNode = micCtx.createMediaStreamSource(stream);
    proc = micCtx.createScriptProcessor(2048, 1, 1);
    proc.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== 1) return;
      // Stream the mic CONTINUOUSLY, including silence. Gemini's VAD needs an
      // unbroken audio stream to detect when a turn ends; if we ever stop sending
      // (e.g. gating out "echo") it can't tell your barge-in finished and stays
      // in listening forever. The browser's echoCancellation handles the model's echo.
      ws.send(floatTo16(e.inputBuffer.getChannelData(0)).buffer);
    };
    srcNode.connect(proc);
    const sink = micCtx.createGain(); sink.gain.value = 0;
    proc.connect(sink); sink.connect(micCtx.destination);
  }

  function stop() {
    running = false;
    flushPlayback();
    if (proc) { try { proc.disconnect(); } catch (e) {} proc = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (ws && ws.readyState <= 1) { try { ws.close(); } catch (e) {} }
    ws = null;
    [micCtx, playCtx].forEach((c) => { if (c && c.state !== "closed") try { c.close(); } catch (e) {} });
    micCtx = playCtx = null;
    cbs.onStatus && cbs.onStatus("idle");
  }

  return { start, stop };
};
