"""Small numpy-only PCA + KMeans so the 'light' profile needs no scikit-learn.

PCA is fit once at index build (mean + top-2 components) and reused to project
query vectors into the same 2D space. KMeans assigns cluster colors.
"""
from __future__ import annotations

import numpy as np


def fit_pca(vectors: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return (mean[D], components[2, D]) for a 2D projection."""
    mean = vectors.mean(axis=0)
    centered = vectors - mean
    # Top-2 right singular vectors are the principal directions.
    _, _, vt = np.linalg.svd(centered, full_matrices=False)
    return mean.astype("float32"), vt[:2].astype("float32")


def project(vectors: np.ndarray, mean: np.ndarray, components: np.ndarray) -> np.ndarray:
    """Project D-dim vectors to 2D using a fitted PCA. Accepts 1D or 2D input."""
    v = np.atleast_2d(vectors)
    return ((v - mean) @ components.T).astype("float32")


def kmeans(coords: np.ndarray, k: int, iters: int = 25, seed: int = 7) -> np.ndarray:
    """Lloyd's algorithm on the 2D coords. Returns an int label per point."""
    n = len(coords)
    k = max(1, min(k, n))
    rng = np.random.default_rng(seed)
    centers = coords[rng.choice(n, size=k, replace=False)].copy()
    labels = np.zeros(n, dtype=int)
    for _ in range(iters):
        d = np.linalg.norm(coords[:, None, :] - centers[None, :, :], axis=2)
        new = d.argmin(axis=1)
        if np.array_equal(new, labels):
            break
        labels = new
        for c in range(k):
            pts = coords[labels == c]
            if len(pts):
                centers[c] = pts.mean(axis=0)
    return labels
