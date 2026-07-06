# Nimbus Voice Agent backend

FastAPI backend for the Nimbus voice-agent playground. See `../PLAN.md` for the
full phased plan. Currently at **Phase 0** (scaffold + scraping).

## Setup

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

Keys are read from the workspace `.env` (one level up): `OPENAI_API_KEY`,
`GEMINI_API_KEY`, `ELEVENLABS_API_KEY`. No keys are ever logged.

## Build the corpus (Phase 0)

```bash
python -m app.scraping.scrape          # catalog.json -> data/docs/*.md
python -m app.scraping.build_context   # data/docs/*.md -> data/context.md
```

Produces 31 docs (7 topic docs + 24 product docs) and a single `context.md`
(~18k words) used as the RAGless payload.

## Run the API

```bash
uvicorn app.main:app --reload --port 8100
curl localhost:8100/health
```

`/health` reports which keys are present, the embedding profile, and whether the
corpus is built.

## Config

- `EMBEDDING_PROFILE` = `rich` (local sentence-transformers, default) or `light`
  (OpenAI embeddings + LLM rerank, Railway-friendly). Used from Phase 3.
