# Deploying your own backend to Railway

You do **not** have access to the original `nimbus-voice-backend` project (verified via
the Railway API: your workspace token sees only `amusing-playfulness` and
`pleasing-perception`). So this sets up *your own* backend instead. Same conclusion as
the GitHub 403 and the Vercel token — the original author owns the live deployments.

## Current state (verified 2026-10-13)

You already created the service, and it has one **FAILED** deployment:

| | |
|---|---|
| Project | `amusing-playfulness` (`185a2d2f-fc4e-4ee8-9475-e08078d24783`) |
| Service | `nimbus-voice-agent` (`0ed219a9-114e-465a-953d-8c0938f047bc`) |
| Environment | `production` (`3d05fbf3-2ed9-47ba-8086-16748c33e172`) |
| Source | `santhoshkumar-io/nimbus-voice-agent`, branch `main` |
| Root directory | **not set** ← this is why it failed |
| Builder | RAILPACK |
| Domain | none |
| App env vars | none |

Build log ends with `railpack prepare exited with an error`: Railway is building from the
**repo root**, where there is no Python app. The backend lives in `backend/`.

## Fix it — 5 settings in the Railway dashboard

Open the `nimbus-voice-agent` service → **Settings**.

1. **Source → Root Directory** → `backend`
   *(the single change that fixes the failed build)*
2. **Source → Branch** → `recover/prod-source-and-runbook`
   `main` on your fork is still the original commit `b197ce9`, which has the **retired
   Gemini model ids** (`gemini-2.5-flash` → 404) and none of the key-handling fixes. Either
   point at this branch, or merge it into `main` first and leave the branch as `main`.
3. **Build → Builder** → `Nixpacks`
   `backend/railway.json` is a Nixpacks config and installs **ffmpeg**, which `app/audio.py`
   needs to transcode uploaded audio for ASR. Railpack ignores it, so ASR would break.
4. **Variables** → add:

   | Name | Value |
   |---|---|
   | `OPENAI_API_KEY` | from your local `.env` |
   | `GEMINI_API_KEY` | from your local `.env` |
   | `ELEVENLABS_API_KEY` | from your local `.env` |
   | `EMBEDDING_PROFILE` | `light` |

   Use these exact names. `ELEVEN_LABS` is **not** read by the code — that is the bug that
   made ElevenLabs look keyless locally. (`config.py` now also accepts aliases, but use the
   canonical name.)
5. **Networking → Generate Domain** (port 8080 or leave default; the app binds `$PORT`).

Then **Deploy**.

## Verify

```bash
H=https://<your-new-domain>

curl -s $H/health | python3 -m json.tool
#   expect keys_env all true, corpus.doc_count 31

curl -s $H/rag/status | python3 -m json.tool
#   the boot warm task builds the index itself: expect built:true,
#   chunks ~336, dim 1536, model text-embedding-3-small (~$0.002 of embeddings)

curl -s -X POST $H/chat -H 'Content-Type: application/json' \
  -d '{"session_id":"v","message":"Say OK","model_key":"gemini-flash","use_context":false,"use_rag":false}'
#   expect text, NOT "404 ... no longer available to new users"
```

## Then point the frontend at it

`playground/runtime-config.js` auto-detects localhost vs deployed, but its deployed
fallback is still the **original** Railway URL. Once your backend is up, change that
fallback to your own domain and redeploy the frontend:

```bash
./build-frontend.sh && cd dist && vercel deploy --prod --token "$VERCEL_TOKEN"
```

## What your backend will and will not do

Works: all 4 models (with the fixed Gemini ids), 11 tools, RAG + rerank + the vector
visualization, RAGless, streaming and batch, all 3 TTS and all 3 server ASR providers.

Missing: **the Twilio phone agent, `WS /live` speech-to-speech, Deepgram and Cartesia.**
Those exist only in the original deployed backend, whose source is still lost — so the
frontend's "Speech-to-speech" pipeline option will fail against your backend. The selector
defaults to `cascade`, so this is opt-in. See `PROD_RECOVERY.md`.
