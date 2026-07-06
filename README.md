# Nimbus Voice Agent

A configurable **voice agent** built on top of a fictitious business-software
website ("Nimbus"). Talk or type to it: it answers product/pricing questions from
a scraped knowledge base and takes real actions (add to cart, checkout, compare
plans) through tools. Every stage of the pipeline — ASR, RAG, LLM, tools, TTS —
is swappable from the frontend, and each reports its latency.

## Live

- **Website + chat box:** https://nimbus-voice-agent-sreedath.vercel.app
- **Voice agent page:** https://nimbus-voice-agent-sreedath.vercel.app/playground/voice.html
- **Playground:** https://nimbus-voice-agent-sreedath.vercel.app/playground/playground.html
- **Backend API:** https://nimbus-api-production-0295.up.railway.app

> Keep the model on **Gemini** for tool use — the default.

## Architecture

- **Frontend** (`nimbus-voice-agent-starter/`, deployed on **Vercel**): the static
  Nimbus site + an embedded "Talk to Nimbus" widget (`assets/widget.js`) with text
  and voice (mic VAD → ASR → chat → TTS, with barge-in).
- **Playground** (`playground/`): a control panel to configure the agent (model,
  RAG, ASR/TTS, voice, tools, latency breakdown, RAG visualization). Writes the
  shared config the widget reads.
- **Backend** (`backend/`, FastAPI on **Railway**): REST + streaming chat with a
  verbatim/summary history model, per-stage latency, RAG (FAISS), a tool registry
  (cart / pricing / checkout), and ASR/TTS across OpenAI, Gemini, and ElevenLabs.

Pipeline today is a cascade (ASR → LLM → TTS). See **[NEXT_SESSION.md](./NEXT_SESSION.md)**
for the roadmap: latency reduction, a native speech-to-speech engine (Gemini Live),
and a public phone number.

## Run locally

```bash
# Backend
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp ../.env.example ../.env   # then fill in OPENAI/GEMINI/ELEVENLABS keys
uvicorn app.main:app --reload --port 8100

# Frontend (from repo root; site at /, playground at /playground/)
python3 serve_nocache.py 8200 nimbus-voice-agent-starter
# open http://localhost:8200  (set the chat box's Backend URL to http://localhost:8100)
```

## Providers / keys

Keys come from `.env` (server-side) or per-request headers the frontend sends
(`X-OpenAI-Key`, `X-Gemini-Key`, `X-ElevenLabs-Key`). See `.env.example`.

## Docs

- `PLAN.md` — original phased implementation plan.
- `NEXT_SESSION.md` — roadmap (latency, speech-to-speech, phone number).
- `voice-agent-details.txt` — pipeline notes.
