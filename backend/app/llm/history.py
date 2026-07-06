"""Conversation history with the spec's verbatim+summary model.

A session holds the full turn list. When building context we keep the most recent
`verbatim` messages as-is and fold everything older into a rolling summary. The
summary is regenerated (one cheap LLM call) only when the aged-out set changes, so
steady-state turns add no summarization latency.

Sessions are immutable-friendly: callers never mutate returned lists; the store
replaces a session's turn list with a new list on each append.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace

from app.llm.providers.base import Message


@dataclass(frozen=True)
class Session:
    turns: tuple[Message, ...] = ()
    summary: str = ""
    summarized_count: int = 0  # how many leading turns the summary already covers


class HistoryStore:
    """In-memory session store (sufficient for the single-process playground)."""

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}

    def get(self, session_id: str) -> Session:
        return self._sessions.get(session_id, Session())

    def reset(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)

    def set(self, session_id: str, session: Session) -> None:
        self._sessions[session_id] = session

    def append(self, session_id: str, role: str, content: str) -> Session:
        cur = self.get(session_id)
        new = replace(cur, turns=cur.turns + (Message(role, content),))
        self._sessions[session_id] = new
        return new

    def annotate_last_assistant(self, session_id: str, note: str) -> bool:
        """Append a note to the most recent assistant turn (barge-in marker), so
        the stored context reflects that TTS was interrupted. Returns success."""
        cur = self.get(session_id)
        for i in range(len(cur.turns) - 1, -1, -1):
            if cur.turns[i].role == "assistant":
                updated = Message("assistant", cur.turns[i].content.rstrip() + " " + note)
                turns = cur.turns[:i] + (updated,) + cur.turns[i + 1:]
                self._sessions[session_id] = replace(cur, turns=turns)
                return True
        return False


def split_for_context(session: Session, verbatim: int) -> tuple[tuple[Message, ...], tuple[Message, ...]]:
    """Return (older, recent) where recent is the last `verbatim` messages."""
    if verbatim <= 0:
        return session.turns, ()
    if len(session.turns) <= verbatim:
        return (), session.turns
    return session.turns[:-verbatim], session.turns[-verbatim:]


def needs_summary(session: Session, older: tuple[Message, ...]) -> bool:
    return bool(older) and len(older) != session.summarized_count


def summary_prompt(prev_summary: str, older: tuple[Message, ...]) -> list[Message]:
    convo = "\n".join(f"{m.role}: {m.content}" for m in older)
    instruction = (
        "Summarize the earlier part of this conversation into a compact paragraph "
        "that preserves user intents, facts established, and any cart or product "
        "decisions. This summary replaces the verbatim turns."
    )
    body = instruction
    if prev_summary:
        body += f"\n\nExisting summary so far:\n{prev_summary}"
    body += f"\n\nConversation to summarize:\n{convo}"
    return [Message("user", body)]
