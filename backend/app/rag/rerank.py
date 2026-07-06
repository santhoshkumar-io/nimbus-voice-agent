"""Profile-based reranking of retrieval candidates.

  light: LLM rerank - ask gpt-4o-mini to order candidates by relevance.
  rich:  cross-encoder (ms-marco-MiniLM-L-6-v2) relevance scores.

Reranking is optional (toggled from the frontend) so its latency is visible.
Both paths degrade gracefully to the original order on any failure.
"""
from __future__ import annotations

import json
import os

import httpx

from app import config

_OPENAI_URL = "https://api.openai.com/v1/chat/completions"
_RERANK_MODEL = "gpt-4o-mini"
_ce_model = None  # cached cross-encoder for the rich profile


def _llm_rerank(query: str, candidates: list[dict], k: int, api_key: str | None) -> list[dict]:
    key = api_key or os.getenv("OPENAI_API_KEY")
    if not key:
        return candidates[:k]
    listing = "\n".join(f"[{i}] {c['doc']} - {c['heading']}: {c['text'][:200]}"
                        for i, c in enumerate(candidates))
    prompt = (
        f"Query: {query}\n\nCandidates:\n{listing}\n\n"
        f"Return ONLY a JSON array of the {k} most relevant candidate indices, "
        f"most relevant first. Example: [3,0,5]"
    )
    try:
        r = httpx.post(
            _OPENAI_URL,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={"model": _RERANK_MODEL, "temperature": 0,
                  "messages": [{"role": "user", "content": prompt}]},
            timeout=httpx.Timeout(30.0, connect=10.0),
        )
        if r.status_code != 200:
            return candidates[:k]
        text = r.json()["choices"][0]["message"]["content"]
        start, end = text.find("["), text.rfind("]")
        order = json.loads(text[start:end + 1])
        picked = [candidates[i] for i in order if isinstance(i, int) and 0 <= i < len(candidates)]
        seen = {id(c) for c in picked}
        picked += [c for c in candidates if id(c) not in seen]
        return picked[:k]
    except Exception:
        return candidates[:k]


def _ce_rerank(query: str, candidates: list[dict], k: int) -> list[dict]:
    global _ce_model
    try:
        if _ce_model is None:
            from sentence_transformers import CrossEncoder
            _ce_model = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")
        scores = _ce_model.predict([(query, c["text"]) for c in candidates])
        ranked = [c for _, c in sorted(zip(scores, candidates), key=lambda p: -p[0])]
        return ranked[:k]
    except Exception:
        return candidates[:k]


def rerank(query: str, candidates: list[dict], k: int, api_key: str | None = None) -> list[dict]:
    if not candidates:
        return []
    if config.EMBEDDING_PROFILE == "rich":
        return _ce_rerank(query, candidates, k)
    return _llm_rerank(query, candidates, k, api_key)
