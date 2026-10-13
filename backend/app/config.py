"""Central config: paths, the available-key registry, and runtime profiles.

No secret values are ever logged or returned; only whether a key is present.
"""
from __future__ import annotations

import os
from pathlib import Path

try:
    from dotenv import load_dotenv

    # Load the workspace .env (one level above backend/) so local runs pick up keys.
    for candidate in (Path(__file__).resolve().parents[2] / ".env",
                      Path(__file__).resolve().parents[3] / ".env"):
        if candidate.exists():
            load_dotenv(candidate, override=False)
except Exception:  # dotenv is optional in deployed envs that inject real env vars
    pass

# ---- paths ----
BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent
SITE_DIR = REPO_ROOT / "nimbus-voice-agent-starter"

DATA_DIR = BACKEND_DIR / "data"

# Prefer the site's catalog when present (local dev); fall back to the bundled
# copy so the backend is self-contained when deployed without the site repo.
_SITE_CATALOG = SITE_DIR / "data" / "catalog.json"
CATALOG_PATH = _SITE_CATALOG if _SITE_CATALOG.exists() else DATA_DIR / "catalog.json"
DOCS_DIR = DATA_DIR / "docs"
CONTEXT_PATH = DATA_DIR / "context.md"
RAG_DIR = DATA_DIR / "rag"

# ---- key registry (presence only) ----
# Maps a logical capability to the env var that powers it.
KEY_REGISTRY = {
    "openai": "OPENAI_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "elevenlabs": "ELEVENLABS_API_KEY",
}

# Accepted misspellings/short forms, checked only if the canonical name is unset.
# A key set under the wrong name used to look identical to "no key at all", which
# silently disabled the default ASR *and* TTS provider with no diagnostic.
KEY_ALIASES = {
    "elevenlabs": ("ELEVEN_LABS", "ELEVENLABS_KEY", "ELEVEN_LABS_API_KEY"),
    "openai": ("OPENAI_KEY",),
    "gemini": ("GOOGLE_API_KEY", "GEMINI_KEY"),
}


def key_for(name: str) -> str | None:
    """The key value for a provider: canonical env var first, then any alias."""
    env = KEY_REGISTRY.get(name)
    if env:
        val = os.getenv(env)
        if val:
            return val
    for alt in KEY_ALIASES.get(name, ()):
        val = os.getenv(alt)
        if val:
            return val
    return None


def key_present(name: str) -> bool:
    return bool(key_for(name))


def available_keys() -> dict[str, bool]:
    return {name: key_present(name) for name in KEY_REGISTRY}


# ---- embedding/rerank profile (Phase 3 uses this; declared here so it is central) ----
# "light" = OpenAI embeddings + LLM rerank (Railway friendly, no torch). Default.
# "rich"  = local sentence-transformers + cross-encoder (best for the demo).
EMBEDDING_PROFILE = os.getenv("EMBEDDING_PROFILE", "light")
