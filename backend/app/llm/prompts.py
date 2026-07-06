"""System-prompt construction, including the RAGless context injection and the
RAG-vs-no-RAG routing rules the spec asks for.
"""
from __future__ import annotations

from pathlib import Path

from app import config

DEFAULT_SYSTEM_PROMPT = (
    "You are the Nimbus voice agent, a helpful assistant for the Nimbus software "
    "suite (a fictional all-in-one business software company). Answer questions "
    "about Nimbus products, pricing, families, refunds, and policies using only the "
    "provided Nimbus knowledge. If something is not covered, say so plainly. Keep a "
    "friendly, concise, spoken tone suitable for being read aloud."
)

# Stated routing policy so the model knows what RAG is and is not for.
ROUTING_RULES = (
    "Knowledge routing:\n"
    "- Use the provided Nimbus knowledge (retrieved context or the knowledge base) "
    "for factual questions about products, features, specs, pricing, families, "
    "refunds, billing, SLA, security, and policies.\n"
    "- Do NOT rely on retrieval for cart math or actions (totals, annual savings, "
    "sorting, add/remove/checkout). Those are handled by tools or direct calculation.\n"
    "- If the knowledge does not contain the answer, say you don't have that "
    "information rather than guessing."
)


def _load_context(max_chars: int) -> str:
    path: Path = config.CONTEXT_PATH
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8")
    return text[:max_chars]


def build_system_prompt(
    *,
    user_system_prompt: str | None,
    length_guidance: str,
    use_context: bool,
    retrieved_context: str | None = None,
    max_context_chars: int = 120_000,
) -> str:
    """Assemble the final system prompt.

    - `use_context=True` with no `retrieved_context` -> RAGless: inject context.md.
    - `retrieved_context` provided -> RAG path: inject only the retrieved chunks.
    """
    base = (user_system_prompt or DEFAULT_SYSTEM_PROMPT).strip()
    parts = [base, ROUTING_RULES, length_guidance.strip()]

    if retrieved_context:
        parts.append(
            "Retrieved Nimbus knowledge (use this to answer):\n"
            + retrieved_context.strip()
        )
    elif use_context:
        ctx = _load_context(max_context_chars)
        if ctx:
            parts.append(
                "Nimbus knowledge base (full corpus, use this to answer):\n" + ctx
            )

    return "\n\n".join(p for p in parts if p)
