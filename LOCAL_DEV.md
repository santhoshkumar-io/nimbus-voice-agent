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

This is easy to misdiagnose as a bad API key, and it silently breaks the
boot-time RAG index build (the warm task swallows exceptions). Build a bundle
from the keychain once:

```bash
cd backend
mkdir -p .venv/certs
security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain  > .venv/certs/macos-ca.pem
security find-certificate -a -p /Library/Keychains/System.keychain                        >> .venv/certs/macos-ca.pem
security find-certificate -a -p ~/Library/Keychains/login.keychain-db                      >> .venv/certs/macos-ca.pem
```

Then always export it when running the backend (both vars — different libraries
read different ones):

```bash
export SSL_CERT_FILE="$PWD/.venv/certs/macos-ca.pem"
export REQUESTS_CA_BUNDLE="$SSL_CERT_FILE"
```

## Run it

Terminal 1 — backend on :8100:

```bash
cd backend
SSL_CERT_FILE="$PWD/.venv/certs/macos-ca.pem" \
REQUESTS_CA_BUNDLE="$PWD/.venv/certs/macos-ca.pem" \
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

Keys present in the workspace `.env`: **OpenAI ✓, Gemini ✓, ElevenLabs ✗**.

Works: text chat on all 4 models, all 11 tools, RAG + reranking + the vector
visualization, RAGless, streaming and batch, OpenAI and Gemini TTS, OpenAI and
Gemini ASR, browser ASR, the latency panels.

Does **not** work locally:

- **ElevenLabs ASR/TTS** — `.env` has `ELEVEN_LABS=` (empty) while all code reads
  `ELEVENLABS_API_KEY`. Both the name and the value need fixing. ElevenLabs is the
  seeded default for ASR *and* TTS, so on the voice page and in the widget
  settings **switch ASR and TTS to OpenAI or Gemini** or those turns fail with 400.
- **The phone agent, `WS /live` speech-to-speech, Deepgram and Cartesia** — these
  exist only in the deployed backend, whose source is missing. See
  `PROD_RECOVERY.md`.

## Measured locally (2026-10-13)

| Thing | Value |
|---|---|
| Prompt tokens, RAGless | **25,390** (108,849 chars) |
| Prompt tokens, RAG top-k=4 | **680** (3,274 chars) — a **97%** reduction |
| FAISS search | 0.3–5 ms |
| Query embedding (OpenAI, remote) | 320–660 ms ← *all* of the RAG latency |
| `/chat` gemini-flash | ~1.8–2.4 s |
| TTS openai / gemini | ~2.3 s / ~2.4 s |

**The interesting result:** RAG cuts the prompt by 97% but is *not* faster
end-to-end (~2.0–2.7 s vs ~2.3–2.4 s ragless), because one remote query embedding
costs ~400 ms while the actual vector search is free. The fix is to embed queries
locally (`EMBEDDING_PROFILE=rich`, MiniLM on-device) — then RAG is both far cheaper
and genuinely faster. Some of the absolute numbers above are inflated by the TLS
proxy, so re-baseline before drawing conclusions about the deployed stack.
