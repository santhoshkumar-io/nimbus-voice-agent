"""A tiny per-stage latency collector used across every phase.

Usage:
    lat = Latency()
    with lat.stage("llm_total"):
        ...work...
    lat.as_dict()  # -> {"llm_total_ms": 12, "total_ms": 12}

It is immutable from the caller's perspective: `as_dict()` returns a fresh dict
each call and never exposes internal state for mutation.
"""
from __future__ import annotations

import time
from contextlib import contextmanager

# The canonical stages reported everywhere. Frontend renders shares from these.
STAGES = (
    "asr",
    "rag",
    "llm_ttft",
    "llm_total",
    "tool",
    "tts",
    "buffer",
)


class Latency:
    def __init__(self) -> None:
        self._ms: dict[str, float] = {}

    @contextmanager
    def stage(self, name: str):
        start = time.perf_counter()
        try:
            yield
        finally:
            self.add(name, (time.perf_counter() - start) * 1000.0)

    def add(self, name: str, ms: float) -> None:
        self._ms[name] = round(self._ms.get(name, 0.0) + ms, 2)

    def as_dict(self) -> dict[str, float]:
        out = {f"{name}_ms": self._ms.get(name, 0.0) for name in STAGES}
        # total excludes llm_ttft (it is a sub-measure of llm_total, not additive).
        total = sum(v for k, v in self._ms.items() if k != "llm_ttft")
        out["total_ms"] = round(total, 2)
        return out
