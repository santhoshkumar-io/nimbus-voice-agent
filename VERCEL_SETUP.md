# Deploying the frontend to Vercel

Every command here was run against this machine and this account before being
written down. Verified 2026-10-13.

## Before you start: two gotchas that cost real time

### 1. `vercel login` fails on this machine — use a token

Interactive login dies with a bare `Error: fetch failed`, and `vercel projects ls`
fails with:

```
Error: self-signed certificate in certificate chain
    at TLSSocket.onConnectSecure (node:internal/tls/wrap:1653:34)
```

This machine terminates TLS through an **inspecting proxy**. `curl` trusts it via the
macOS keychain; Node ships its own CA store and does not. It is not a bad token and
not a network outage — the same root cause broke Python earlier.

**Fix** — export the keychain to a PEM and point Node at it:

```bash
./make-ca-bundle.sh
export NODE_EXTRA_CA_CERTS="$PWD/certs/macos-ca.pem"
```

Verify:

```bash
vercel whoami --token "$VERCEL_TOKEN"     # -> santhoshkumars1903-7719
```

Add the export to your shell profile so it survives new terminals.

### 2. The playground reaches the site through a symlink

`nimbus-voice-agent-starter/playground -> ../playground`. Vercel does **not** follow
it, so deploying that directory publishes the marketing site with **no playground at
all** — and it fails silently, looking like a successful deploy. Always build first:

```bash
./build-frontend.sh      # copies with -L into dist/, then asserts the result
```

The script fails loudly if `dist/playground` is still a link or if any entry point
(including the recovered `s2s.js`) is missing.

## Two routes

**Route A — Git integration (dashboard).** Auto-deploys on every push. Use the settings
below; they are not the defaults Vercel suggests.

**Route B — CLI** (further down). One-off, no repo wiring.

---

## Route A — importing the repo in the dashboard

Vercel's import screen guesses wrong on three fields for this repo. Set them explicitly:

| Field | Vercel suggests | Use |
|---|---|---|
| **Root Directory** | `backend` (it detects FastAPI) | **the repository root** — not `backend`, not `playground`, not `nimbus-voice-agent-starter` |
| **Framework Preset** | `FastAPI` | **Other** |
| Build Command | (none) | left to `vercel.json` |

**Root Directory must be the repo root.** The site lives in
`nimbus-voice-agent-starter/`, but it reaches the playground through a symlink
(`nimbus-voice-agent-starter/playground -> ../playground`) that points *outside* that
folder. Vercel will not follow a symlink that escapes the root directory, so selecting
`nimbus-voice-agent-starter` publishes the site with a broken playground, and selecting
`playground` publishes the playground with no site, no `assets/` and no
`data/catalog.json`.

From the repo root, `vercel.json` takes over and does the right thing:

```json
{
  "buildCommand": "bash ./build-frontend.sh",
  "outputDirectory": "dist",
  "framework": null,
  "installCommand": "echo 'no dependencies to install'"
}
```

`build-frontend.sh` copies with `-L`, which turns the symlink into real files, and then
asserts the result — so a broken deploy fails the build instead of shipping silently.
This works on Vercel because git stores the symlink properly (mode `120000`), so the
checkout recreates it. Verified locally by running the build exactly as Vercel does.

### Changing the branch

The import screen has **no branch selector** — Vercel always imports the repository's
**default branch**, which on your fork is `main`.

`main` is still the original commit `b197ce9`: it has the **retired Gemini model ids**
(`gemini-2.5-flash` → HTTP 404) and none of the fixes. Deploying it gets you a frontend
pointing at the *original* backend too, since the corrected
`playground/runtime-config.js` only exists on the branch.

Two ways to fix, after the project exists:

1. **Merge the branch into `main` on your fork** (recommended). It is your repo, both
   Vercel and Railway already track `main`, and you get auto-deploys with nothing
   pinned. On GitHub: open a PR from `recover/prod-source-and-runbook` into `main` and
   merge it.
2. **Or repoint Vercel:** Project → **Settings → Git → Production Branch** →
   `recover/prod-source-and-runbook` → Save, then redeploy. Note Railway is configured
   this way already, so you would have the branch pinned in two places.

---

## Your token


Already present in the gitignored `.env` as `VERCEL_TOKEN`. It was originally spelled
`VERECEL_TOKEN`, which no tooling reads — the same class of bug as `ELEVEN_LABS`. If
you need a new one: https://vercel.com/account/tokens

```bash
export VERCEL_TOKEN=$(grep '^VERCEL_TOKEN=' .env | cut -d= -f2- | tr -d '"'"'"')
```

## Route B — deploying from the CLI

```bash
cd /Users/santhosh.kumar/Documents/Voice-agent/nimbus-voice-agent

export NODE_EXTRA_CA_CERTS="$PWD/certs/macos-ca.pem"
export VERCEL_TOKEN=$(grep '^VERCEL_TOKEN=' .env | cut -d= -f2- | tr -d '"'"'"')

./build-frontend.sh

vercel deploy --prod --yes \
  --project nimbus-voice-agent \
  --cwd dist \
  --token "$VERCEL_TOKEN"
```

`--project nimbus-voice-agent` matters: without it the project is named after the
directory you deploy from, i.e. **`dist`**. Drop `--prod` for a preview URL instead of
a production one.

## Verify

```bash
U=https://<deployment-url>

for p in / /playground/playground.html /playground/voice.html /playground/rag.html \
         /assets/widget.js /assets/s2s.js /playground/s2s.js /data/catalog.json; do
  printf '%-32s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "$U$p")"
done
```

All should be `200`. A `404` on `/playground/...` means the symlink was not
dereferenced — rebuild with `./build-frontend.sh`.

Then confirm it is talking to the right backend:

```bash
curl -s $U/playground/runtime-config.js | grep railway
# -> https://nimbus-voice-agent-production.up.railway.app
```

Finally open the site and send one message in the "Talk to Nimbus" box.

## Which backend it talks to

`playground/runtime-config.js` auto-detects:

| Served from | Backend |
|---|---|
| localhost / 127.0.0.1 | `http://127.0.0.1:8100` |
| anything else | `https://nimbus-voice-agent-production.up.railway.app` |

That is **our own** Railway backend (see `RAILWAY_SETUP.md`), not the original
`nimbus-api-production-0295`, which we have no access to and whose `GEMINI_API_KEY` is
invalid. If the backend domain changes, edit that one file and redeploy — the URL is
deliberately not duplicated anywhere else any more.

The backend sets `allow_origins=["*"]`, so a new Vercel domain needs no CORS change.

## What will and will not work once deployed

Works: text chat on all 4 models (Gemini included — our backend uses the live
`gemini-3.5-flash`), all 11 cart/pricing tools, RAG with reranking, the vector
visualization, RAGless, streaming and batch, all 3 TTS and all 3 server ASR providers,
browser ASR, and the latency panels.

Does not work, because it needs the **lost** backend source:

- the voice page / widget **"Speech-to-speech"** pipeline option (needs `WS /live`)
- **Deepgram** ASR and **Cartesia** TTS (no keys, and no server support in this tree)
- the **"Flash TTS"** latency-lab toggle — it sends `fast: true`, but this backend's
  `TTSBody` has no `fast` field, so the value is silently dropped

The pipeline selector defaults to `cascade`, so s2s is opt-in and nothing breaks by
default. See `PROD_RECOVERY.md`.

## Note on third-party embeds

`index.html` also embeds a **Vapi** widget and a **LiveKit** popup alongside the custom
agent. Their identifiers are client-side public by design, but anyone loading your page
can exercise those assistants against your accounts — so set origin allowlists and
spend limits in the Vapi and LiveKit dashboards. LiveKit additionally needs the new
Vercel domain allowlisted or its launcher will not appear.
