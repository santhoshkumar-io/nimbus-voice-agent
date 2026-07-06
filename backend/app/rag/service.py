"""RAG query service: embed -> FAISS search -> optional rerank, with a latency
breakdown, plus the data the visualization needs.
"""
from __future__ import annotations

import time

from app.rag import embed, index, rerank as reranker

POOL_MULTIPLIER = 3   # candidates fetched before rerank = k * this (min 12)


def ensure_built(api_key: str | None = None) -> dict:
    if not index.is_built():
        return index.build(api_key)
    return index.status()


def _format_context(results: list[dict]) -> str:
    return "\n\n".join(
        f"[{r['doc']} - {r['heading']}]\n{r['text']}" for r in results
    )


def query(text: str, k: int = 4, do_rerank: bool = False, api_key: str | None = None) -> dict:
    """Retrieve top-k chunks for `text`. Returns results + latency + context string."""
    timing: dict[str, float] = {}

    t0 = time.perf_counter()
    qvec = embed.embed_query(text, api_key)
    timing["embed_ms"] = (time.perf_counter() - t0) * 1000.0

    pool = max(k * POOL_MULTIPLIER, 12) if do_rerank else k
    t0 = time.perf_counter()
    candidates = index.search(qvec, pool)
    timing["search_ms"] = (time.perf_counter() - t0) * 1000.0

    if do_rerank:
        t0 = time.perf_counter()
        results = reranker.rerank(text, candidates, k, api_key)
        timing["rerank_ms"] = (time.perf_counter() - t0) * 1000.0
    else:
        results = candidates[:k]
        timing["rerank_ms"] = 0.0

    timing["rag_ms"] = round(sum(timing.values()), 2)
    for key in timing:
        timing[key] = round(timing[key], 2)

    return {
        "results": results,
        "context": _format_context(results),
        "latency": timing,
        "qvec": qvec,
        "k": k,
        "reranked": do_rerank,
    }


def query_with_viz(text: str, k: int = 4, do_rerank: bool = False, api_key: str | None = None) -> dict:
    """As query(), plus the query's 2D point and the retrieved chunk ids for the
    visualization to highlight."""
    res = query(text, k, do_rerank, api_key)
    point = index.project_query(res["qvec"])
    res.pop("qvec", None)
    return {
        **res,
        "query_point": point,
        "retrieved_ids": [r["id"] for r in res["results"]],
    }
