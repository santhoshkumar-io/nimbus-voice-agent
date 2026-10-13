"""Model registry: logical names -> (provider, model id, label).

The frontend lists these; only models whose provider key is present are usable.
Response-length presets live here too so the orchestrator and UI agree.
"""
from __future__ import annotations

from dataclasses import dataclass

from app import config


@dataclass(frozen=True)
class ModelSpec:
    key: str          # logical id used by the API/frontend
    provider: str     # "openai" | "gemini"
    model_id: str     # the real model id sent to the provider
    label: str        # human label for the UI


MODELS: tuple[ModelSpec, ...] = (
    ModelSpec("openai-lite", "openai", "gpt-4o-mini", "OpenAI - lite (gpt-4o-mini)"),
    ModelSpec("openai-heavy", "openai", "gpt-4o", "OpenAI - heavyweight (gpt-4o)"),
    # 2026-10: gemini-2.5-flash / -pro were retired ("no longer available to new
    # users", HTTP 404). gemini-3.8-flash is Google's named successor but was
    # returning 503 "high demand" on 4/4 probes, while 3.5-flash passed 4/4 --
    # so flash is pinned to 3.5. Pinned, not "-latest": a floating alias is what
    # broke silently in the first place.
    ModelSpec("gemini-flash", "gemini", "gemini-3.5-flash", "Gemini - flash (3.5)"),
    ModelSpec("gemini-pro", "gemini", "gemini-3.1-pro-preview", "Gemini - pro (3.1 preview)"),
)

_BY_KEY = {m.key: m for m in MODELS}

# The cheap model used for background summarization of aged-out history.
SUMMARIZER_KEY = "openai-lite"

# Response length -> (max output tokens, prompt guidance appended to system).
LENGTH_PRESETS = {
    "low": (130, "Answer in 1-2 short sentences. Be direct."),
    "medium": (400, "Answer concisely in a short paragraph."),
    "high": (1000, "Answer thoroughly, with detail and structure where useful."),
}


# The widget historically shipped short|long in its settings UI, which silently
# fell back to "medium" because only low|medium|high exist. Accept the aliases so
# configs already persisted in users' localStorage resolve to what they meant.
_LENGTH_ALIASES = {"short": "low", "long": "high"}


def resolve_length(name: str | None) -> tuple[int, str]:
    """Map a requested response length (incl. legacy aliases) to its preset."""
    key = _LENGTH_ALIASES.get((name or "").lower(), (name or "").lower())
    return LENGTH_PRESETS.get(key, LENGTH_PRESETS["medium"])


def get_model(key: str) -> ModelSpec:
    if key not in _BY_KEY:
        raise ValueError(f"unknown model '{key}'. Known: {list(_BY_KEY)}")
    return _BY_KEY[key]


def available_models() -> list[dict]:
    """Models annotated with whether their provider key is present."""
    return [
        {
            "key": m.key,
            "label": m.label,
            "provider": m.provider,
            "available": config.key_present(m.provider),
        }
        for m in MODELS
    ]
