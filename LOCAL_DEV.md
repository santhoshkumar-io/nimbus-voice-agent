# Local development

Runs the whole stack on your machine with no Railway, no Vercel and no GitHub
write access. Verified working 2026-10-13.

## One-time setup

System Python is 3.9, but the project needs 3.12 (the pinned `numpy==2.4.4`
does not even publish a 3.9 wheel). `uv` handles that without admin rights:

```bash
cd backend
uv venv --python 3.12
uv pip install -r requirements.txt
```

### TLS: you must point Python at the macOS trust store

This machine terminates TLS through an inspecting proxy. `curl` trusts it via the
system keychain, but Python's `httpx` ships its own `certifi` bundle and does not,
so **every** outbound provider call fails with:

```
[SSL: CERTIFICATE_VERIFY_FAILED] self-signed certificate in certificate chain
```

The same proxy also breaks the Vercel CLI (`Error: self-signed certificate in
certificate chain`), so one bundle serves both. This is easy to misdiagnose as a
bad API key, and it silently breaks the boot-time RAG index build (the warm task
swallows exceptions).

Build the bundle once from the repo root:

```bash
./make-ca-bundle.sh          # writes certs/macos-ca.pem (gitignored)
```

Then export it — different runtimes read different variables:

```bash
export SSL_CERT_FILE="$PWD/certs/macos-ca.pem"        # Python / httpx
export REQUESTS_CA_BUNDLE="$PWD/certs/macos-ca.pem"   # requests
export NODE_EXTRA_CA_CERTS="$PWD/certs/macos-ca.pem"  # Node / Vercel CLI
```

Add them to your shell profile so new terminals inherit them.

## Run it

Terminal 1 — backend on :8100:

```bash
cd backend
SSL_CERT_FILE="$PWD/../certs/macos-ca.pem" \
REQUESTS_CA_BUNDLE="$PWD/../certs/macos-ca.pem" \
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8100
```

Terminal 2 — site + playground on :8200:

```bash
python3 serve_nocache.py 8200 nimbus-voice-agent-starter
```

Open:

| URL | What |
|---|---|
| http://127.0.0.1:8200/ | Nimbus site + "Talk to Nimbus" widget |
| http://127.0.0.1:8200/playground/playground.html | text playground (all controls) |
| http://127.0.0.1:8200/playground/voice.html | voice agent |
| http://127.0.0.1:8200/playground/rag.html | vector visualization |

`playground/runtime-config.js` auto-detects: served from localhost it targets
`http://127.0.0.1:8100`, anywhere else the Railway backend. Nothing to edit, and
the API-keys dialog still overrides it.

The FAISS index builds itself on first boot (~336 chunks, ~$0.002 of embeddings).
Force a rebuild with `curl -X POST localhost:8100/rag/build -d '{"clusters":8}' -H 'Content-Type: application/json'`.

## What works locally, and what does not

Keys in `nimbus-voice-agent/.env`: **OpenAI ✓, Gemini ✓, ElevenLabs ✓**.

Works: text chat on all 4 models, all 11 tools, RAG + reranking + the vector
visualization, RAGless, streaming and batch, **all three TTS providers**, **all
three server ASR providers**, browser ASR, the latency panels.

> The key must be named `ELEVENLABS_API_KEY`. It was originally `ELEVEN_LABS`,
> which no code reads, so it looked identical to "no key at all". `config.py` now
> also accepts aliases (`ELEVEN_LABS`, `ELEVENLABS_KEY`, …) via `config.key_for()`,
> which ASR, TTS and the embedder all route through — so a misnamed var still
> works instead of silently disabling a provider.

Does **not** work locally: **the phone agent, `WS /live` speech-to-speech, Deepgram
and Cartesia** — these exist only in the deployed backend, whose source is missing.
See `PROD_RECOVERY.md`.

## Measured locally (2026-10-13)

| Thing | Value |
|---|---|
| Prompt tokens, RAGless | **25,390** (108,849 chars) |
| Prompt tokens, RAG top-k=4 | **680** (3,274 chars) — a **97%** reduction |
| FAISS search | 0.3–5 ms |
| Query embedding (OpenAI, remote) | 320–660 ms ← *all* of the RAG latency |
| `/chat` gemini-flash | ~1.8–2.4 s |
| TTS elevenlabs / openai / gemini | 2.20 s / 2.40 s / 3.42 s |
| ASR openai / elevenlabs / gemini | 1.08 s / 1.47 s / 1.73 s |

Gemini ASR was pinned to **`gemini-3.5-flash-lite`**, not `-flash`: transcription
needs no reasoning, and flash spent 4.1 s (once 17 s cold) on a clip flash-lite
handled in 1.7 s with an identical transcript.

Accuracy note from a TTS→ASR round trip of *"Hello, this is Nimbus speaking."* —
only **ElevenLabs** got the brand name right; OpenAI heard "Nimbe" and Gemini
"Nimba". If product names matter in the demo, prefer ElevenLabs ASR.

**The interesting result:** RAG cuts the prompt by 97% but is *not* faster
end-to-end (~2.0–2.7 s vs ~2.3–2.4 s ragless), because one remote query embedding
costs ~400 ms while the actual vector search is free. The fix is to embed queries
locally (`EMBEDDING_PROFILE=rich`, MiniLM on-device) — then RAG is both far cheaper
and genuinely faster. Some of the absolute numbers above are inflated by the TLS
proxy, so re-baseline before drawing conclusions about the deployed stack.
