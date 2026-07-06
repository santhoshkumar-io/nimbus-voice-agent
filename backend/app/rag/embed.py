"""Profile-based embeddings behind one interface.

  light: OpenAI text-embedding-3-small (1536-d), no heavy deps. Default.
  rich:  sentence-transformers all-MiniLM-L6-v2 (384-d), local, opt-in.

Vectors are L2-normalized so FAISS inner-product == cosine similarity.
"""
from __future__ import annotations

import os

import httpx
import numpy as np

from app import config

_OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings"
_LIGHT_MODEL = "text-embedding-3-small"
_RICH_MODEL = "all-MiniLM-L6-v2"
_TIMEOUT = httpx.Timeout(60.0, connect=10.0)

_st_model = None  # cached sentence-transformers model for the rich profile


def profile() -> str:
    return config.EMBEDDING_PROFILE


def model_label() -> str:
    return _LIGHT_MODEL if profile() == "light" else _RICH_MODEL


def _normalize(arr: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return (arr / norms).astype("float32")


def _openai_key(override: str | None) -> str:
    key = override or os.getenv("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("OpenAI key required for the 'light' embedding profile.")
    return key


def _embed_openai(texts: list[str], api_key: str | None) -> np.ndarray:
    key = _openai_key(api_key)
    vecs: list[list[float]] = []
    with httpx.Client(timeout=_TIMEOUT) as client:
        for i in range(0, len(texts), 256):  # batch to stay within request limits
            batch = texts[i:i + 256]
            r = client.post(
                _OPENAI_EMBED_URL,
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json={"model": _LIGHT_MODEL, "input": batch},
            )
            if r.status_code != 200:
                raise RuntimeError(f"OpenAI embeddings error {r.status_code}: {r.text[:200]}")
            vecs.extend(d["embedding"] for d in r.json()["data"])
    return _normalize(np.array(vecs, dtype="float32"))


def _embed_rich(texts: list[str]) -> np.ndarray:
    global _st_model
    if _st_model is None:
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as e:
            raise RuntimeError(
                "EMBEDDING_PROFILE=rich needs 'sentence-transformers'. "
                "Install it or switch to the 'light' profile."
            ) from e
        _st_model = SentenceTransformer(_RICH_MODEL)
    arr = np.asarray(_st_model.encode(texts, batch_size=64, show_progress_bar=False), dtype="float32")
    return _normalize(arr)


def embed_texts(texts: list[str], api_key: str | None = None) -> np.ndarray:
    if not texts:
        return np.zeros((0, 1), dtype="float32")
    return _embed_openai(texts, api_key) if profile() == "light" else _embed_rich(texts)


def embed_query(text: str, api_key: str | None = None) -> np.ndarray:
    return embed_texts([text], api_key)[0]
