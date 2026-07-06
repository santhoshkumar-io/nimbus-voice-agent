"""Build / load the FAISS index and the precomputed 2D projection.

Artifacts (under data/rag/):
  faiss.index      - FAISS IndexFlatIP over normalized vectors (cosine)
  embeddings.npy   - the same vectors (for PCA / query nearest checks)
  chunks.json      - chunk metadata aligned to vector rows
  projection.json  - {points:[{x,y,cluster}], pca:{mean,components}, profile, dim}
"""
from __future__ import annotations

import json
from collections import Counter

import faiss
import numpy as np

from app import config
from app.rag import chunk as chunker
from app.rag import embed, viz_math

# Friendly names for the non-product topic docs.
_TOPIC_NAMES = {
    "faq": "FAQ", "refund": "Refund", "terms": "Terms & policies",
    "pricing": "Pricing", "monthly-vs-annual": "Monthly vs annual",
    "families": "Families", "company": "Company",
}


def _topic_map() -> dict[str, str]:
    """doc stem -> topic label. Product docs map to their category."""
    cat = json.loads(config.CATALOG_PATH.read_text(encoding="utf-8"))
    m = {p["id"]: p.get("category", "Products") for p in cat.get("products", [])}
    m.update(_TOPIC_NAMES)
    return m


def _topic_of(doc: str, topics: dict[str, str]) -> str:
    if doc in topics:
        return topics[doc]
    return doc.replace("-", " ").title()


def _cluster_labels(points: list[dict], k: int) -> list[str]:
    """Name each cluster by the most common topic among its chunks (plus a close
    runner-up), so the legend reads 'FAQ', 'Refund', 'Finance', etc."""
    topics = _topic_map()
    labels: list[str] = []
    for c in range(k):
        members = [_topic_of(p["doc"], topics) for p in points if p["cluster"] == c]
        if not members:
            labels.append(f"cluster {c}")
            continue
        ranked = Counter(members).most_common()
        name = ranked[0][0]
        if len(ranked) > 1 and ranked[1][1] >= ranked[0][1] * 0.6:
            name += " + " + ranked[1][0]
        labels.append(name)
    return labels

_FAISS = config.RAG_DIR / "faiss.index"
_EMB = config.RAG_DIR / "embeddings.npy"
_CHUNKS = config.RAG_DIR / "chunks.json"
_PROJ = config.RAG_DIR / "projection.json"

# Loaded state (kept in memory after first load).
_state: dict = {}


def is_built() -> bool:
    return _FAISS.exists() and _CHUNKS.exists() and _PROJ.exists()


def build(api_key: str | None = None, clusters: int = 8) -> dict:
    config.RAG_DIR.mkdir(parents=True, exist_ok=True)
    chunks = chunker.build_chunks()
    vectors = embed.embed_texts([c.embed_text() for c in chunks], api_key)
    dim = int(vectors.shape[1])

    ix = faiss.IndexFlatIP(dim)
    ix.add(vectors)
    faiss.write_index(ix, str(_FAISS))
    np.save(_EMB, vectors)
    _CHUNKS.write_text(json.dumps([c.as_dict() for c in chunks]), encoding="utf-8")

    mean, comps = viz_math.fit_pca(vectors)
    coords = viz_math.project(vectors, mean, comps)
    labels = viz_math.kmeans(coords, clusters)
    points = [
        {"id": chunks[i].id, "x": float(coords[i, 0]), "y": float(coords[i, 1]),
         "cluster": int(labels[i]), "doc": chunks[i].doc, "heading": chunks[i].heading,
         "preview": chunks[i].text[:90], "text": chunks[i].text}
        for i in range(len(chunks))
    ]
    _PROJ.write_text(json.dumps({
        "points": points,
        "cluster_labels": _cluster_labels(points, clusters),
        "pca": {"mean": mean.tolist(), "components": comps.tolist()},
        "profile": embed.profile(), "model": embed.model_label(),
        "dim": dim, "clusters": clusters,
    }), encoding="utf-8")

    _state.clear()
    return {"chunks": len(chunks), "dim": dim, "profile": embed.profile(),
            "model": embed.model_label(), "clusters": clusters}


def _load() -> dict:
    if _state:
        return _state
    if not is_built():
        raise RuntimeError("RAG index not built. POST /rag/build first.")
    _state["index"] = faiss.read_index(str(_FAISS))
    _state["embeddings"] = np.load(_EMB)
    _state["chunks"] = json.loads(_CHUNKS.read_text(encoding="utf-8"))
    _state["projection"] = json.loads(_PROJ.read_text(encoding="utf-8"))
    return _state


def status() -> dict:
    if not is_built():
        return {"built": False, "profile": embed.profile(), "model": embed.model_label()}
    proj = json.loads(_PROJ.read_text(encoding="utf-8"))
    return {"built": True, "chunks": len(proj["points"]), "dim": proj["dim"],
            "profile": proj["profile"], "model": proj["model"], "clusters": proj["clusters"]}


def search(query_vec: np.ndarray, k: int) -> list[dict]:
    st = _load()
    scores, idx = st["index"].search(query_vec.reshape(1, -1).astype("float32"), k)
    out = []
    for rank, (i, s) in enumerate(zip(idx[0], scores[0])):
        if i < 0:
            continue
        meta = st["chunks"][i]
        out.append({**meta, "score": float(s), "rank": rank})
    return out


def projection() -> dict:
    return _load()["projection"]


def project_query(query_vec: np.ndarray) -> dict:
    st = _load()
    pca = st["projection"]["pca"]
    mean = np.array(pca["mean"], dtype="float32")
    comps = np.array(pca["components"], dtype="float32")
    xy = viz_math.project(query_vec, mean, comps)[0]
    return {"x": float(xy[0]), "y": float(xy[1])}
