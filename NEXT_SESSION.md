# Nimbus Voice Agent — Next Session Plan

Three goals for the final session: **(1) reduce latency**, **(2) full speech-to-speech
model with tools**, **(3) public phone number people can call to ask about products.**

---

> ## ⚠️ READ `PROD_RECOVERY.md` BEFORE DEPLOYING ANYTHING (added 2026-10-13)
>
> **Do not run `railway up` from this repo.** The deployed backend is a *newer version*
> than this source tree, and that source is missing from git and from this disk. Deploying
> from here would delete the Twilio phone agent, the `WS /live` Gemini Live engine,
> Deepgram/Cartesia support, and Gemini embeddings from production.
>
> Also corrected below: **the "OpenAI keys are 429" claim in this file is stale.** The
> OpenAI key now works (embeddings 200, chat 200), so RAG was never blocked by it.
> Production Gemini is down for a different reason: the Railway `GEMINI_API_KEY` is
> **invalid** (400 "API key not valid"), and the `gemini-2.5-*` model ids are retired (404).



## Where things stand now (already done)

- **Frontend (Vercel):** https://nimbus-voice-agent-sreedath.vercel.app
  (Vercel auth gate disabled so it's public. Old alias `nimbus-voice-agent-omega.vercel.app` still works.)
- **Backend (Railway):** https://nimbus-api-production-0295.up.railway.app
  (project `nimbus-voice-backend`, service `nimbus-api`; redeploy with `railway up` from `backend/`)
- Pipeline today = **cascade**: mic → record (wait ~700ms silence) → ASR upload → LLM → TTS → play.
- Defaults: model **gemini-2.5-flash**, knowledge **ragless** (full 107KB / ~27k-token context every turn),
  ASR **ElevenLabs scribe_v1** (English pinned), TTS **ElevenLabs eleven_turbo_v2_5**.
- Chat-box widget uses **batch** mode; the voice page (`playground/voice.html`) already **streams** TTS sentence-by-sentence.
- Tools work (11 tools: add_to_cart, checkout, etc.). ~~Keep model on **Gemini** — OpenAI keys are 429 (out of quota).~~
  **[STALE 2026-10-13]** OpenAI works fine now; **Gemini** is the broken one (invalid Railway key + retired model ids).
- Diagnostic: `GET {backend}/debug/chat_log` shows recent requests (model, tools on/off, which tool ran).

---

## 1. Reduce latency (on the current cascade)

Ranked by impact:

1. **Stream the chat-box widget** (biggest perceived win, ~2-3×). It currently waits for the
   entire LLM reply + full TTS before any audio. Port the sentence-by-sentence streaming that
   `playground/voice.js` already does into `assets/widget.js`.
2. **Ragless → RAG** to shrink the prompt. Full context.md (~27k tokens) is injected every turn.
   RAG retrieves ~4 chunks (~2k tokens) → much faster TTFT + cheaper.
   - ~~**Blocker:** RAG embeddings currently use OpenAI (429).~~ **[STALE]** OpenAI embeddings return 200.
     Prod already runs `EMBEDDING_PROFILE=gemini` (`gemini-embedding-001`); the index is simply unbuilt.
     **Old note: add Gemini embeddings**
     (`text-embedding-004`) or local MiniLM (`EMBEDDING_PROFILE=rich`). Rebuild the FAISS index.
3. **Faster TTS:** switch ElevenLabs `eleven_turbo_v2_5` → **`eleven_flash_v2_5`** (~75ms). Consider streaming TTS chunks.
4. **Streaming ASR** instead of record-then-upload: browser Web Speech (instant, local, free) as
   default, or Deepgram / Gemini streaming STT. Removes the "wait for silence + upload + transcribe" gap.
5. **Gemini prompt caching** if staying ragless — cache the big system prompt, pay for it once.
6. **Params/network:** response_length short for voice, lower max_tokens, Railway region near providers, keep-alive.

> Cascade floor even when fully tuned ≈ 0.8-1.5s round trip. To go lower → item 2.
> Nice-to-have: instrument before/after latency numbers (per-stage) to show the improvement.

## 2. Full speech-to-speech model with tools

Replace the ASR+LLM+TTS cascade with a **native realtime speech-to-speech model**.

- **Choice: Gemini Live API** (`gemini-2.0-flash-live` / `gemini-live-2.5-flash`) — WebSocket,
  native audio in/out, **built-in function calling** (the 11 tools map directly), built-in barge-in/VAD.
  Chosen because OpenAI Realtime is quota-blocked; uses the existing Gemini key.
- **Architecture:** browser mic → WebSocket to FastAPI backend → Gemini Live WS (audio both ways)
  → tool calls dispatched to the existing tool registry (`app/tools/registry.py`) → audio streamed back.
- **~300-800ms**, natural turn-taking. Reuses tool registry, cart store, and knowledge (as system instruction).
- This is a real build (new WS endpoint + client audio worklet) but it's the **core of both low latency AND the phone.**

## 3. Public phone number (call to ask about products)

Two paths (DECISION NEEDED — see open questions):

- **A — DIY: Twilio + Gemini Live (most control, reuses backend).**
  Twilio number (~$1/mo) + **Media Streams** bridges call audio over a WebSocket to the FastAPI
  backend → the Gemini Live engine (item 2) → audio streamed back. People call → same agent + tools.
  Needs: **Twilio account (SID + auth token) + a purchased number.**
- **B — Managed: Vapi / Retell / Bland (fastest to ship).**
  Platform provides the number and runs the realtime voice agent; plug in prompt + tools (webhook to
  backend for cart/pricing) + knowledge. Least code, monthly cost, less control. Needs an account/API key.

---

## Recommended build order

1. **Latency quick-wins** (stream widget + Gemini-embedding RAG + Flash TTS) — fast, visible.
2. **Gemini Live speech-to-speech engine** (low-latency core + tools).
3. **Attach telephony** (Twilio Media Streams → the Gemini Live engine) for the phone number.

> 2 and 3 share the engine, so building 2 first makes 3 mostly wiring.

## Open decisions / what's needed before starting

- [ ] **Phone path:** DIY Twilio vs managed (Vapi/Retell/Bland)?
- [ ] **Credentials:** Twilio SID/auth-token + number, OR managed-platform API key.
- [ ] Confirm **Gemini Live** for speech-to-speech (existing Gemini key works).
- [ ] Fix OpenAI quota (429) if OpenAI models/embeddings are wanted — otherwise stay Gemini-only.
- [ ] Country/number type + any cost ceiling for the phone number.

## Handy commands

```bash
# Backend (Railway) — from backend/ after `railway login`
railway up   # ⚠️ DO NOT RUN — see PROD_RECOVERY.md; this tree is older than prod
curl {backend}/debug/chat_log               # inspect recent chat requests

# Frontend (Vercel) — from a copy of nimbus-voice-agent-starter/ (deref playground symlink)
vercel deploy --prod --yes --scope sreedaths-projects --token $VERCEL_TOKEN
vercel alias set <deployment> nimbus-voice-agent-sreedath.vercel.app --scope sreedaths-projects --token $VERCEL_TOKEN
```
