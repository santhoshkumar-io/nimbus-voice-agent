# Nimbus Voice Agent: Implementation Plan

A configurable voice-agent **playground** built on top of the static Nimbus site
(`nimbus-voice-agent-starter/`). Every stage of the pipeline (ASR, RAG, LLM,
tools, TTS) is swappable from the frontend, and every stage reports its latency.

## Scope decisions (locked)

- **LLM providers:** OpenAI (lite + heavyweight) and Gemini. **Anthropic is out of
  scope** (no key) and is not built.
- **Public phone number / telephony: out of scope** (no Twilio). Web + voice in
  the browser only.
- **Embedding + rerank are pluggable "profiles"** so the backend can run on Railway:
  - `light` (Railway default): OpenAI `text-embedding-3-small` + LLM rerank
    (`gpt-4o-mini`). No `torch`, small image, low RAM.
  - `rich` (local default): `sentence-transformers` MiniLM + cross-encoder rerank.
    Free, fast locally, best for the clustering visualization.
  - One env var (`EMBEDDING_PROFILE`) switches them; same retrieve/rerank interface.
- **Keys available:** OpenAI, Gemini, ElevenLabs, Railway, Vercel.

## Stack

- **Backend:** Python + FastAPI on Railway. One WebSocket carries the streaming
  voice loop; REST for everything else. Per-stage timing baked into every response.
- **Frontend:** new pages added to the existing static site, deployed on Vercel.
- **Vector store:** FAISS (local file index), rebuilt from the scraped corpus.

## Repository layout (target)

```
build-voice-agent-live/
  nimbus-voice-agent-starter/   # existing static site (unchanged catalog)
  backend/
    app/
      main.py                   # FastAPI app, REST + WS routes
      config.py                 # key registry, model registry, profiles
      latency.py                # per-stage timer -> latency dict
      scraping/
        scrape.py               # catalog.json (+ optional GitHub) -> structured docs
        build_context.py        # docs/*.md -> one big context.md
      rag/
        chunk.py  embed.py  index.py  retrieve.py  rerank.py  viz.py
      llm/
        providers/ openai.py  gemini.py
        orchestrator.py         # stream|batch, tool loop, RAG routing
        history.py              # N verbatim + summarized older turns
        prompts.py              # system prompt + RAG-vs-no-RAG routing rules
      tools/
        cart.py  pricing.py  products.py  registry.py
      asr/ providers/ gemini.py  elevenlabs.py  openai.py     # browser ASR = client
      tts/ providers/ openai.py  gemini.py  elevenlabs.py  buffer.py
    data/
      docs/*.md   context.md   faiss.index   chunks.json
    requirements.txt  Dockerfile  railway.json
  playground/                   # served by the static site (Vercel)
    playground.html  playground.js   # the big control panel
    voice.html       voice.js        # full-setup voice page
    widget.js                         # landing-page "Talk to Nimbus" chatbox
  PLAN.md
```

The static site's cart (`assets/cart.js`, localStorage key `nimbus_cart`, item
shape `{product_id, product_name, tier, seats, price}`) is the shared cart. Cart
tools read/write the same shape so the site and the agent stay in sync.

---

## Phase 0: Scaffold + scraping

**Goal:** backend skeleton + a clean corpus. Everything downstream needs the corpus.

- FastAPI app with `/health`, config loading keys from env, model + profile registry.
- `scrape.py`: parse `data/catalog.json` into structured markdown, one doc per
  topic the spec lists: **FAQ, Products (one per product), Families/categories,
  Pricing, Refund, T&C, Monthly vs Annual**. Optional GitHub README scrape behind
  a flag. Output to `backend/data/docs/*.md`.
- `build_context.py`: concatenate docs into one `context.md` (the RAGless payload).
- **Deliverable:** `docs/*.md` + `context.md` to review. No agent logic yet.

## Phase 1: RAGless + LLM core + text chat

**Goal:** first end-to-end working agent (text only), every latency shown.

- Provider adapters: OpenAI lite (`gpt-4o-mini`), OpenAI heavy (`gpt-4o`), Gemini
  (`gemini-2.5-flash` / `pro`). Unified `complete()` and `stream()`.
- **Streaming vs batch:** both modes, returning `llm_ttft_ms` (time-to-first-token)
  and `llm_total_ms`; UI shows a side-by-side latency comparison.
- **System prompt:** editable from the frontend.
- **Response length:** low / medium / high (maps to max-tokens + prompt guidance).
- **History:** keep the last *N* turns verbatim (user-set slider); older turns are
  summarized into a rolling summary. Both go into context.
- **RAGless path:** inject `context.md` directly into the system context.
- Text chatbox in `playground.html`, latency readout per turn (`llm`, `total`).
- **Deliverable:** working text chat with provider/mode/length/history controls.

## Phase 2: Tools

**Goal:** all 11 tools, individually toggleable, with tool latency.

Tools (cart shape matches the site):
1. cart total pricing  2. add to cart  3. checkout (whole cart)
4. annual-format pricing  5. % savings annual-vs-monthly
6. sort products by price (asc/desc)  7. top-k most expensive products
8. remove one item  9. checkout one item  10. clear cart
11. (helper) get product / tier details for grounding

- `registry.py`: tool schemas + an **enable/disable map**. Frontend can select
  **all / none / any subset**; disabled tools are not advertised to the LLM.
- Tool-call loop in the orchestrator; each tool call timed (`tool_ms`).
- Server session cart bridged to the site's `nimbus_cart` shape.
- **Deliverable:** "add CRM Pro to my cart / what's my annual total / clear it"
  works, with a tools on/off panel.

## Phase 3: RAG

**Goal:** RAG vs RAGless toggle, FAISS retrieval + rerank, and the visualizations.

- `chunk.py`: chunk the docs (size/overlap configurable).
- `embed.py`: profile-based embeddings (`light` = OpenAI, `rich` = MiniLM).
- `index.py`: build/load **FAISS** index + `chunks.json` metadata.
- `retrieve.py`: top-k (k set from the frontend) by vector similarity.
- `rerank.py`: rerank top-N (`light` = LLM rerank, `rich` = cross-encoder).
- **RAG vs RAGless toggle:** RAG adds retrieval+rerank latency (`rag_ms`), shown
  explicitly; RAGless uses `context.md`. System prompt states **which question
  types use RAG vs which don't** (catalog/policy facts -> RAG; cart math/actions
  -> tools, no RAG).
- **`viz.py`:** project all chunk vectors to 2D (PCA in numpy; optional UMAP under
  `rich`) + KMeans cluster labels -> a scatter the frontend renders. On a query,
  return the query's 2D point + the nearest-k chunks highlighted.
- Frontend: embedding-model label, **top-k slider**, RAG on/off, `rag_ms` readout,
  vector-cluster scatter, and a query-overlay view.
- **Deliverable:** ask a catalog/policy question, watch retrieval + clusters + latency.

## Phase 4: Voice (ASR + TTS + the loop)

**Goal:** the actual voice agent with barge-in, endpointing, and full latency.

- **ASR:** browser (Web Speech API, client-side) + Gemini + ElevenLabs + OpenAI
  (server-side). Transcript shown live in the chatbox; `asr_ms` reported.
- **TTS:** OpenAI + Gemini + ElevenLabs, with an audio **buffer**; show buffer size
  and the `buffer_ms` it adds (and why no buffer risks choppy playback). `tts_ms`.
- **Voice loop over WebSocket:** mic -> ASR -> (RAG?) -> LLM (stream|batch) ->
  tools -> TTS -> playback. Streaming mode pipelines LLM tokens into TTS chunks.
- **Endpoint detection:** silence-duration **slider** (500 / 700 ms, etc.).
- **Barge-in / interrupt:** user speech during TTS stops playback immediately and
  appends `[cancelled by the user]` to the LLM context so history matches what was
  actually heard.
- **Latency dashboard:** combine every stage (`asr`, `rag`, `llm`, `tool`, `tts`,
  `buffer`) into a bar/pie chart showing each stage's % share + total ms.
- `voice.html`: the full-setup voice page with all controls.
- **Deliverable:** talk to Nimbus, interrupt it, tune endpointing, read the latency split.

## Phase 5: Landing chatbox + deploy

**Goal:** the finalized agent embedded on the site + everything live.

- `widget.js`: a "Talk to Nimbus" chatbox on `index.html` using the finalized
  config, bridged to `nimbus_cart`.
- Deploy backend to **Railway** with `EMBEDDING_PROFILE=light`; deploy the static
  site + playground to **Vercel**. CORS + WS URL wired through config.
- **Deliverable:** public playground + landing-page agent.

---

## Latency model (consistent everywhere)

Every turn returns:

```json
{
  "asr_ms": 0, "rag_ms": 0, "llm_ttft_ms": 0, "llm_total_ms": 0,
  "tool_ms": 0, "tts_ms": 0, "buffer_ms": 0, "total_ms": 0
}
```

The frontend renders stage shares (bar/pie) + total, and a streaming-vs-batch
comparison from `llm_ttft_ms` vs `llm_total_ms`.

## Out of scope (explicit)

- Anthropic LLM provider, public phone number / Twilio auth.

## Open items to confirm during the build

- Exact OpenAI/Gemini model ids for "lite" vs "heavyweight".
- Whether to scrape the GitHub repo in addition to `catalog.json` (default: catalog only).
- ElevenLabs voice id and default TTS provider.
</content>
