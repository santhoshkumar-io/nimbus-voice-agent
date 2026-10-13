"""Ties providers + prompts + history + latency into one chat turn.

Exposes:
  - run_batch(req)  -> dict (full text + latency + meta)
  - run_stream(req) -> async generator of SSE-ready event dicts

The same message assembly feeds both so streaming and batch are comparable.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import AsyncIterator

from app.latency import Latency
from app.llm import history as H
from app.llm import prompts, registry
from app.llm.providers.base import Message, ProviderError
from app.llm.providers.gemini import GeminiProvider
from app.llm.providers.openai import OpenAIProvider
from app.tools import registry as tools_registry

_PROVIDERS = {"openai": OpenAIProvider(), "gemini": GeminiProvider()}
_STORE = H.HistoryStore()


@dataclass(frozen=True)
class ChatRequest:
    session_id: str
    message: str
    model_key: str = "openai-lite"
    mode: str = "batch"               # "batch" | "stream"
    system_prompt: str | None = None
    response_length: str = "medium"   # low | medium | high
    verbatim_turns: int = 6           # recent messages kept verbatim
    use_context: bool = True          # RAGless: inject context.md
    temperature: float = 0.5
    keys: dict[str, str] = None       # provider -> api key (from frontend)
    tools_enabled: bool = False       # master switch for tool use
    enabled_tools: list[str] = None   # subset of tool names; None = all
    use_rag: bool = False             # retrieve chunks instead of full context.md
    top_k: int = 4                    # chunks to retrieve
    rerank: bool = False              # rerank retrieved candidates

    def key_for(self, provider: str) -> str:
        return (self.keys or {}).get(provider, "")

    def active_tool_specs(self):
        if not self.tools_enabled:
            return []
        return tools_registry.enabled_specs(self.enabled_tools)


def reset_session(session_id: str) -> None:
    _STORE.reset(session_id)


def cancel_last(session_id: str, note: str = "[cancelled by the user]") -> bool:
    """Mark the last assistant turn as interrupted (barge-in)."""
    return _STORE.annotate_last_assistant(session_id, note)


def _provider_for(model_key: str):
    spec = registry.get_model(model_key)
    return _PROVIDERS[spec.provider], spec


def _retrieve(req: "ChatRequest", lat: Latency):
    """Run RAG retrieval if requested; returns (context_string_or_None, rag_meta)."""
    if not req.use_rag:
        return None, None
    from app.rag import service as rag_service
    res = rag_service.query(req.message, k=req.top_k, do_rerank=req.rerank,
                            api_key=req.key_for("openai"))
    lat.add("rag", res["latency"]["rag_ms"])
    rag_meta = {
        "k": res["k"], "reranked": res["reranked"], "rag_latency": res["latency"],
        "chunks": [{"doc": r["doc"], "heading": r["heading"], "score": round(r["score"], 4)}
                   for r in res["results"]],
    }
    return res["context"], rag_meta


async def _ensure_summary(req: ChatRequest, session: H.Session, older, lat: Latency) -> H.Session:
    """Summarize aged-out turns if needed, using the cheap summarizer model."""
    if not H.needs_summary(session, older):
        return session
    prov, spec = _provider_for(registry.SUMMARIZER_KEY)
    api_key = req.key_for(spec.provider)
    if not api_key:
        # No key for the summarizer: skip summarization rather than fail the turn.
        return session
    with lat.stage("tool"):  # count summary cost as overhead (separate bucket below)
        comp = await prov.complete(
            api_key=api_key,
            model_id=spec.model_id,
            messages=H.summary_prompt(session.summary, older),
            max_tokens=300,
            temperature=0.2,
        )
    updated = replace(session, summary=comp.text.strip(), summarized_count=len(older))
    _STORE.set(req.session_id, updated)
    return updated


def _assemble(req: ChatRequest, session: H.Session, retrieved_context: str | None):
    max_tokens, guidance = registry.resolve_length(req.response_length)
    older, recent = H.split_for_context(session, req.verbatim_turns)
    system_text = prompts.build_system_prompt(
        user_system_prompt=req.system_prompt,
        length_guidance=guidance,
        use_context=req.use_context,
        retrieved_context=retrieved_context,
    )
    msgs: list[Message] = [Message("system", system_text)]
    if session.summary:
        msgs.append(Message("system", f"Summary of earlier conversation:\n{session.summary}"))
    msgs.extend(recent)
    msgs.append(Message("user", req.message))
    return msgs, max_tokens, older


def _provider_tool_schema(provider_name, specs):
    if provider_name == "openai":
        return tools_registry.openai_schema(specs)
    return tools_registry.gemini_schema(specs)


async def _run_tool_loop(req, prov, spec, msgs, max_tokens, lat):
    """Run the provider's native tool loop; record llm + tool latency. Returns
    (text, trace) or raises ProviderError."""
    specs = req.active_tool_specs()
    schema = _provider_tool_schema(spec.provider, specs)

    def dispatch(name, args):
        return tools_registry.dispatch(name, args, req.session_id)

    run = await prov.chat_with_tools(
        api_key=req.key_for(spec.provider),
        model_id=spec.model_id,
        messages=msgs,
        tool_schema=schema,
        dispatch=dispatch,
        max_tokens=max_tokens,
        temperature=req.temperature,
    )
    lat.add("llm_total", run.llm_ms)
    lat.add("llm_ttft", run.llm_ms)  # tool turns are non-streamed
    lat.add("tool", run.tool_ms)
    return run.text, run.trace


def _meta(spec, mode, msgs, older, session, trace=None):
    from app.llm import tokens
    sys_chars = sum(len(m.content) for m in msgs if m.role == "system")
    return {
        "model": spec.label,
        "model_key": spec.key,
        "mode": mode,
        "system_chars": sys_chars,
        "prompt_tokens": tokens.count_messages(msgs)["total_tokens"],
        "verbatim_messages": len([m for m in msgs if m.role in ("user", "assistant")]) - 1,
        "summarized_messages": len(older),
        "summary_used": bool(session.summary),
        "tool_calls": [{"name": t["name"], "args": t["args"], "ms": t["ms"]} for t in (trace or [])],
    }


async def _prepare(req: ChatRequest, lat: Latency):
    """Shared setup: summary, RAG retrieval, message assembly (no LLM call)."""
    prov, spec = _provider_for(req.model_key)
    session = _STORE.get(req.session_id)
    older, _ = H.split_for_context(session, req.verbatim_turns)
    session = await _ensure_summary(req, session, older, lat)
    retrieved_context, rag_meta = _retrieve(req, lat)
    msgs, max_tokens, older = _assemble(req, session, retrieved_context)
    return prov, spec, session, msgs, max_tokens, older, rag_meta


async def assemble_messages(req: ChatRequest) -> tuple[list[Message], dict | None]:
    """Build exactly the messages that would be sent, for the context inspector."""
    _, _, _, msgs, _, _, rag_meta = await _prepare(req, Latency())
    return msgs, rag_meta


async def run_batch(req: ChatRequest) -> dict:
    lat = Latency()
    prov, spec, session, msgs, max_tokens, older, rag_meta = await _prepare(req, lat)
    trace = None
    try:
        if req.active_tool_specs():
            text, trace = await _run_tool_loop(req, prov, spec, msgs, max_tokens, lat)
        else:
            with lat.stage("llm_total"):
                comp = await prov.complete(
                    api_key=req.key_for(spec.provider),
                    model_id=spec.model_id,
                    messages=msgs,
                    max_tokens=max_tokens,
                    temperature=req.temperature,
                )
            text = comp.text
            lat.add("llm_ttft", lat.as_dict()["llm_total_ms"])  # batch: first token == full
    except ProviderError as e:
        return {"error": str(e)}

    _STORE.append(req.session_id, "user", req.message)
    _STORE.append(req.session_id, "assistant", text)
    meta = _meta(spec, "batch", msgs, older, session, trace)
    meta["rag"] = rag_meta
    return {"text": text, "latency": lat.as_dict(), "meta": meta}


async def run_stream(req: ChatRequest) -> AsyncIterator[dict]:
    import time

    lat = Latency()
    prov, spec, session, msgs, max_tokens, older, rag_meta = await _prepare(req, lat)

    # Tool turns run non-streamed (the model may take several steps); emit the
    # resolved answer as one delta so the frontend code path is identical.
    if req.active_tool_specs():
        try:
            text, trace = await _run_tool_loop(req, prov, spec, msgs, max_tokens, lat)
        except ProviderError as e:
            yield {"type": "error", "error": str(e)}
            return
        yield {"type": "delta", "text": text}
        _STORE.append(req.session_id, "user", req.message)
        _STORE.append(req.session_id, "assistant", text)
        meta = _meta(spec, "stream(tools)", msgs, older, session, trace)
        meta["rag"] = rag_meta
        yield {"type": "done", "latency": lat.as_dict(), "meta": meta}
        return

    pieces: list[str] = []
    start = time.perf_counter()
    first_at: float | None = None
    try:
        async for delta in prov.stream(
            api_key=req.key_for(spec.provider),
            model_id=spec.model_id,
            messages=msgs,
            max_tokens=max_tokens,
            temperature=req.temperature,
        ):
            if first_at is None:
                first_at = time.perf_counter()
                lat.add("llm_ttft", (first_at - start) * 1000.0)
            pieces.append(delta)
            yield {"type": "delta", "text": delta}
    except ProviderError as e:
        yield {"type": "error", "error": str(e)}
        return

    lat.add("llm_total", (time.perf_counter() - start) * 1000.0)
    text = "".join(pieces)
    _STORE.append(req.session_id, "user", req.message)
    _STORE.append(req.session_id, "assistant", text)
    meta = _meta(spec, "stream", msgs, older, session)
    meta["rag"] = rag_meta
    yield {"type": "done", "latency": lat.as_dict(), "meta": meta}
