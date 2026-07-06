"""Gemini provider (batch + streaming) over httpx.

Normalized messages are mapped to Gemini's shape: system messages become a single
systemInstruction; assistant -> "model", user -> "user".
"""
from __future__ import annotations

import json
import time
from typing import AsyncIterator

import httpx

from app.llm.providers.base import Completion, Dispatch, Message, ProviderError, ToolRunResult

_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
_TIMEOUT = httpx.Timeout(60.0, connect=10.0)


def _to_gemini(messages: list[Message]):
    system_txt = "\n\n".join(m.content for m in messages if m.role == "system")
    contents = [
        {"role": "model" if m.role == "assistant" else "user", "parts": [{"text": m.content}]}
        for m in messages
        if m.role != "system"
    ]
    body: dict = {"contents": contents}
    if system_txt:
        body["systemInstruction"] = {"parts": [{"text": system_txt}]}
    return body


def _payload(messages, max_tokens, temperature):
    body = _to_gemini(messages)
    body["generationConfig"] = {"maxOutputTokens": max_tokens, "temperature": temperature}
    return body


class GeminiProvider:
    name = "gemini"

    async def complete(self, *, api_key, model_id, messages, max_tokens, temperature) -> Completion:
        if not api_key:
            raise ProviderError("Missing Gemini API key. Add it in the playground settings.")
        url = f"{_BASE}/{model_id}:generateContent?key={api_key}"
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            try:
                r = await client.post(url, json=_payload(messages, max_tokens, temperature))
            except httpx.HTTPError as e:
                raise ProviderError(f"Gemini request failed: {e}") from e
        if r.status_code != 200:
            raise ProviderError(f"Gemini error {r.status_code}: {_err(r)}")
        data = r.json()
        text = _extract_text(data)
        usage = data.get("usageMetadata") or {}
        return Completion(text, usage.get("promptTokenCount"), usage.get("candidatesTokenCount"))

    async def stream(self, *, api_key, model_id, messages, max_tokens, temperature) -> AsyncIterator[str]:
        if not api_key:
            raise ProviderError("Missing Gemini API key. Add it in the playground settings.")
        url = f"{_BASE}/{model_id}:streamGenerateContent?alt=sse&key={api_key}"
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            async with client.stream("POST", url, json=_payload(messages, max_tokens, temperature)) as r:
                if r.status_code != 200:
                    body = (await r.aread()).decode("utf-8", "replace")
                    raise ProviderError(f"Gemini stream error {r.status_code}: {body[:300]}")
                async for line in r.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    try:
                        piece = _extract_text(json.loads(line[6:]))
                    except json.JSONDecodeError:
                        continue
                    if piece:
                        yield piece


    async def chat_with_tools(
        self, *, api_key, model_id, messages, tool_schema, dispatch: Dispatch,
        max_tokens, temperature, max_iters=6,
    ) -> ToolRunResult:
        if not api_key:
            raise ProviderError("Missing Gemini API key. Add it in the playground settings.")
        url = f"{_BASE}/{model_id}:generateContent?key={api_key}"
        body = _to_gemini(messages)
        contents = body["contents"]
        base = {k: v for k, v in body.items() if k != "contents"}
        base["tools"] = tool_schema
        base["generationConfig"] = {"maxOutputTokens": max_tokens, "temperature": temperature}
        res = ToolRunResult(text="")
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            for _ in range(max_iters):
                res.iters += 1
                t0 = time.perf_counter()
                r = await client.post(url, json={**base, "contents": contents})
                res.llm_ms += (time.perf_counter() - t0) * 1000.0
                if r.status_code != 200:
                    raise ProviderError(f"Gemini error {r.status_code}: {_err(r)}")
                cand = (r.json().get("candidates") or [{}])[0]
                parts = cand.get("content", {}).get("parts", [])
                calls = [p["functionCall"] for p in parts if "functionCall" in p]
                if not calls:
                    res.text = "".join(p["text"] for p in parts if "text" in p)
                    return res
                contents.append({"role": "model", "parts": parts})
                resp_parts = []
                for fc in calls:
                    name = fc.get("name", "")
                    args = fc.get("args", {}) or {}
                    ts = time.perf_counter()
                    result = dispatch(name, args)
                    ms = (time.perf_counter() - ts) * 1000.0
                    res.tool_ms += ms
                    res.trace.append({"name": name, "args": args, "result": result, "ms": round(ms, 2)})
                    resp_parts.append({"functionResponse": {"name": name, "response": {"result": result}}})
                contents.append({"role": "user", "parts": resp_parts})
        res.text = res.text or "I wasn't able to finish that action."
        return res


def _extract_text(data: dict) -> str:
    out = []
    for cand in data.get("candidates", []):
        for part in cand.get("content", {}).get("parts", []):
            if "text" in part:
                out.append(part["text"])
    return "".join(out)


def _err(r: httpx.Response) -> str:
    try:
        return r.json().get("error", {}).get("message", r.text)[:300]
    except Exception:
        return r.text[:300]
