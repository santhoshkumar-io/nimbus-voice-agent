"""OpenAI chat-completions provider (batch + streaming) over httpx."""
from __future__ import annotations

import json
import time
from typing import AsyncIterator

import httpx

from app.llm.providers.base import Completion, Dispatch, Message, ProviderError, ToolRunResult

_URL = "https://api.openai.com/v1/chat/completions"
_TIMEOUT = httpx.Timeout(60.0, connect=10.0)


def _payload(model_id, messages, max_tokens, temperature, stream):
    return {
        "model": model_id,
        "messages": [{"role": m.role, "content": m.content} for m in messages],
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": stream,
    }


def _headers(api_key: str) -> dict:
    if not api_key:
        raise ProviderError("Missing OpenAI API key. Add it in the playground settings.")
    return {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}


class OpenAIProvider:
    name = "openai"

    async def complete(self, *, api_key, model_id, messages, max_tokens, temperature) -> Completion:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            try:
                r = await client.post(
                    _URL,
                    headers=_headers(api_key),
                    json=_payload(model_id, messages, max_tokens, temperature, False),
                )
            except httpx.HTTPError as e:
                raise ProviderError(f"OpenAI request failed: {e}") from e
        if r.status_code != 200:
            raise ProviderError(f"OpenAI error {r.status_code}: {_err(r)}")
        data = r.json()
        text = data["choices"][0]["message"]["content"] or ""
        usage = data.get("usage") or {}
        return Completion(text, usage.get("prompt_tokens"), usage.get("completion_tokens"))

    async def stream(self, *, api_key, model_id, messages, max_tokens, temperature) -> AsyncIterator[str]:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            async with client.stream(
                "POST",
                _URL,
                headers=_headers(api_key),
                json=_payload(model_id, messages, max_tokens, temperature, True),
            ) as r:
                if r.status_code != 200:
                    body = (await r.aread()).decode("utf-8", "replace")
                    raise ProviderError(f"OpenAI stream error {r.status_code}: {body[:300]}")
                async for line in r.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    chunk = line[6:].strip()
                    if chunk == "[DONE]":
                        break
                    try:
                        delta = json.loads(chunk)["choices"][0]["delta"].get("content")
                    except (json.JSONDecodeError, KeyError, IndexError):
                        continue
                    if delta:
                        yield delta


    async def chat_with_tools(
        self, *, api_key, model_id, messages, tool_schema, dispatch: Dispatch,
        max_tokens, temperature, max_iters=6,
    ) -> ToolRunResult:
        native = [{"role": m.role, "content": m.content} for m in messages]
        res = ToolRunResult(text="")
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            for _ in range(max_iters):
                res.iters += 1
                payload = {
                    "model": model_id, "messages": native, "max_tokens": max_tokens,
                    "temperature": temperature, "tools": tool_schema, "tool_choice": "auto",
                }
                t0 = time.perf_counter()
                r = await client.post(_URL, headers=_headers(api_key), json=payload)
                res.llm_ms += (time.perf_counter() - t0) * 1000.0
                if r.status_code != 200:
                    raise ProviderError(f"OpenAI error {r.status_code}: {_err(r)}")
                msg = r.json()["choices"][0]["message"]
                calls = msg.get("tool_calls") or []
                if not calls:
                    res.text = msg.get("content") or ""
                    return res
                native.append({"role": "assistant", "content": msg.get("content"), "tool_calls": calls})
                for tc in calls:
                    name = tc["function"]["name"]
                    try:
                        args = json.loads(tc["function"].get("arguments") or "{}")
                    except json.JSONDecodeError:
                        args = {}
                    ts = time.perf_counter()
                    result = dispatch(name, args)
                    ms = (time.perf_counter() - ts) * 1000.0
                    res.tool_ms += ms
                    res.trace.append({"name": name, "args": args, "result": result, "ms": round(ms, 2)})
                    native.append({"role": "tool", "tool_call_id": tc["id"], "content": json.dumps(result)})
        res.text = res.text or "I wasn't able to finish that action."
        return res


def _err(r: httpx.Response) -> str:
    try:
        return r.json().get("error", {}).get("message", r.text)[:300]
    except Exception:
        return r.text[:300]
