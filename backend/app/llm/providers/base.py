"""Provider interface + shared types.

A provider turns a list of normalized messages into either a full completion or a
stream of text deltas. Keys are passed in explicitly (the frontend supplies them
per request); providers never read the environment directly.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import AsyncIterator, Callable, Literal, Protocol

Role = Literal["system", "user", "assistant"]

# A dispatch callback: (tool_name, args) -> JSON-safe result dict.
Dispatch = Callable[[str, dict], dict]


@dataclass(frozen=True)
class Message:
    role: Role
    content: str


@dataclass(frozen=True)
class Completion:
    text: str
    prompt_tokens: int | None = None
    completion_tokens: int | None = None


@dataclass
class ToolRunResult:
    text: str
    trace: list[dict] = field(default_factory=list)  # [{name,args,result,ms}]
    llm_ms: float = 0.0
    tool_ms: float = 0.0
    iters: int = 0


class ProviderError(RuntimeError):
    """Raised with a user-safe message when a provider call fails."""


class LLMProvider(Protocol):
    name: str

    async def complete(
        self,
        *,
        api_key: str,
        model_id: str,
        messages: list[Message],
        max_tokens: int,
        temperature: float,
    ) -> Completion: ...

    def stream(
        self,
        *,
        api_key: str,
        model_id: str,
        messages: list[Message],
        max_tokens: int,
        temperature: float,
    ) -> AsyncIterator[str]: ...
