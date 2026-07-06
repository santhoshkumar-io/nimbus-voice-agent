"""Token counting for the context inspector.

Uses tiktoken's o200k_base (the encoding used by current OpenAI models). For
Gemini this is a close estimate, not exact, and is labeled as such in the UI.
"""
from __future__ import annotations

from functools import lru_cache


@lru_cache(maxsize=1)
def _enc():
    import tiktoken
    return tiktoken.get_encoding("o200k_base")


def count(text: str) -> int:
    if not text:
        return 0
    try:
        return len(_enc().encode(text))
    except Exception:
        return max(1, len(text) // 4)  # rough fallback


def count_messages(messages: list) -> dict:
    """messages: list of objects with .role/.content. Returns per-message + totals."""
    per = []
    total_tokens = total_chars = 0
    for m in messages:
        role = getattr(m, "role", m.get("role") if isinstance(m, dict) else "")
        content = getattr(m, "content", m.get("content") if isinstance(m, dict) else "")
        tk = count(content)
        per.append({"role": role, "chars": len(content), "tokens": tk,
                    "content": content})
        total_tokens += tk
        total_chars += len(content)
    return {"messages": per, "total_tokens": total_tokens, "total_chars": total_chars}
