# Production Recovery Runbook

> **STOP — do not run `railway up` from this repo.**
> The deployed backend is a **newer version than this source tree**, and that source is not
> in git, not on this disk, and not in any other checkout. Deploying from here would delete
> the phone agent, the realtime engine, Deepgram/Cartesia support, and Gemini embeddings
> from production. Recover the source first (Step 2 below).

Verified 2026-10-13 against `https://nimbus-api-production-0295.up.railway.app`.

## What production has that this repo does not

| Prod | This repo |
|---|---|
| 22 routes | 17 routes |
| `POST /twilio/incoming` → returns real TwiML | absent |
| `WS /twilio/stream` (Twilio Media Streams bridge) | absent |
| `WS /live` (Gemini Live speech-to-speech) | absent |
| `POST /latency/compare` (cascade vs s2s) | absent |
| `GET/POST /debug/live_log`, `/debug/live_log/clear` | absent |
| `POST /callback` (Twilio status callback) | absent |
| `keys_env` includes `deepgram`, `cartesia` | only openai/gemini/elevenlabs |
| `embedding_profile: "gemini"` (`gemini-embedding-001`) | only `light`/`rich` — no Gemini profile |
| `/models` includes `gemma-google` ("Gemma 4 31B") | 4 models |
| `TTSBody` has a **`fast: bool`** field | 3 fields, no `fast` |
| ASR list includes `deepgram`; TTS list includes `cartesia` | 4 ASR / 3 TTS |

`TTSBody.fast` is real and effective — measured on prod, ElevenLabs TTS:
`fast=false → 432 ms`, `fast=true → 232 ms`.

A snapshot of the live API surface is saved in `recovery/prod-surface/` (openapi.json,
health, models, voices, tools, rag/status, debug logs, the TwiML response) so the surface
is preserved in git even if the container restarts.

## The frontend was also lost — and is now RECOVERED

There are two Vercel deployments. Both point at the same backend
(`nimbus-api-production-0295`), so **v2 + prod backend are the matched pair** and this repo
is the older v1:

| Deployment | vs this repo |
|---|---|
| `nimbus-voice-agent-sreedath.vercel.app` | identical to local (v1) |
| `nimbus-voice-agent-sreedath-v2.vercel.app` | **newer — source was missing** |

Because the frontend is static, it was fully recoverable over plain HTTP (no CLI needed).
All 23 files are saved in **`recovery/prod-frontend-v2/`**. Drift vs this repo:

| File | v2 | local | delta |
|---|---|---|---|
| `playground/voice.js` | 34,446 | 22,865 | **+11,581** |
| `assets/app.js` | 14,178 | 9,682 | +4,496 |
| `assets/widget.js` | 30,312 | 26,576 | +3,736 |
| `playground/playground.js` | 16,905 | 14,741 | +2,164 |
| `index.html` | 4,350 | 3,000 | +1,350 |
| `render.js`, `cart.js`, `styles.css`, `rag.js` | — | — | unchanged |

What v2 adds that this repo has no trace of:

- **Deepgram ASR** and **Cartesia TTS** selectors (matching the prod `/health` keys)
- a **Krisp** noise-suppression key (`k_krisp`) and a `noise` / `noiseHint` control
- a **`pipeline`** selector — cascade vs **s2s** (speech-to-speech); `s2s` appears in
  `index.html`, `voice.html`, `voice.js`, `playground.html`, `playground.js`, `widget.js`
- **`latMaster` / `latSwitches`** — latency optimization toggles
- `/live` wiring in `assets/widget.js`, and `POST /latency/compare` calls in `playground.js`
- use of the `fast` TTS flag

So the s2s/Live client **does** exist in v2 (contrary to an earlier assumption that no
client had been built) — it is wired into the existing voice page via the `pipeline`
selector rather than a separate `live.html`.

**Only the backend source is still missing.** That is what Step 2 recovers.

## Step 1 — Fix the invalid Railway Gemini key (highest value, 2 minutes)

Production Gemini is **down**, and it is not (only) the retired model ids:

```
POST /chat model_key=gemini-flash  -> {"error":"Gemini error 400: API key not valid."}
POST /chat model_key=openai-lite   -> "OK!"  (876 ms)   <- OpenAI is healthy
```

`GET /health` wrongly reports `"gemini": true` because it only checks that the env var
*exists*, never that it works. The key in the local workspace `.env` **is** valid
(ListModels → 200, embeddings → 200).

Do this:

1. Open Railway → project **`nimbus-voice-backend`** → service **`nimbus-api`** → **Variables**.
2. Set `GEMINI_API_KEY` to the value of `GEMINI_API_KEY` in `/Users/santhosh.kumar/Documents/Voice-agent/.env`.
3. Save; let the service redeploy (this redeploys the *existing* image — it does **not**
   push this source tree, so it is safe).

Verify:

```bash
H=https://nimbus-api-production-0295.up.railway.app

# should return text, not "API key not valid"
curl -s -X POST $H/chat -H 'Content-Type: application/json' \
  -d '{"session_id":"v","message":"Say OK","model_key":"gemini-flash","use_context":false,"use_rag":false}'

# the Gemini-embedding warm task can now run; expect built:true within ~60s
curl -s $H/rag/status
```

Fixing this one variable un-breaks: Gemini chat, Gemini ASR, the Gemini-embedding RAG
index build, and the `/live` speech-to-speech engine (which uses the same key).

> Note: the registry's Gemini **model ids are also retired** — `gemini-2.5-flash` and
> `gemini-2.5-pro` both return 404 "no longer available to new users" even with a valid
> key. Google's replacements: `gemini-3.8-flash` and `gemini-3.1-pro-preview`. That is a
> code fix, so it must wait until Step 2 recovers the source.

## Step 2 — Recover the deployed source out of the container

The Railway CLI is not installed and there is no `RAILWAY_TOKEN`. `npm` is available,
`brew` is not.

```bash
npm i -g @railway/cli
railway login                       # interactive browser auth
cd /Users/santhosh.kumar/Documents/Voice-agent/nimbus-voice-agent/backend
railway link                        # pick project nimbus-voice-backend, service nimbus-api
railway ssh -- tar czf - -C /app . > /tmp/nimbus-prod-src.tgz
```

Then extract to a scratch dir and diff against this tree:

```bash
mkdir -p /tmp/nimbus-prod && tar xzf /tmp/nimbus-prod-src.tgz -C /tmp/nimbus-prod
diff -ru backend/app /tmp/nimbus-prod/app | head -200
```

Commit the recovered code on a branch (`recover/prod-backend`) **before** changing anything.

### Fallbacks if `railway ssh` is unavailable on this plan

1. Railway dashboard → service → **Deployments** → open the `railway up` deployment → check
   for a downloadable source snapshot / build context.
2. `railway logs --deployment <id>` may reveal the file list from the build phase.
3. Last resort: reconstruct from `recovery/prod-surface/openapi.json` plus this runbook's
   delta table. The audio bridge (Twilio 8 kHz µ-law ↔ Gemini Live PCM) is the only
   genuinely hard part to rebuild.

## Step 3 — Only after Step 2

Resume the approved plan, rebased onto the recovered source. Several planned items are
already done in production and must not be re-implemented:

- Phase 5 (Twilio phone agent + Gemini Live engine) — **already built and deployed**
- Phase 3c (faster TTS) — **already present** as `TTSBody.fast`

Still genuinely outstanding after recovery:

- Retired Gemini model ids (`gemini-2.5-flash` / `-pro` → 404) — needs the recovered backend
- RAG index has never been built (`/rag/status` → `built: false`)
- A `/health` check that validates keys rather than just their presence
  (it reported `gemini: true` while Gemini was returning 400)
- `/voices` advertises `deepgram` + `cartesia` even though both keys are absent
- Deepgram / Cartesia / Krisp keys are absent in Railway, so those v2 options are dead ends
- Local-only: `.env` has `ELEVEN_LABS=` (empty) but all code reads `ELEVENLABS_API_KEY`
- Spec gaps never built anywhere: GitHub/website scraping, `.txt` corpus output
