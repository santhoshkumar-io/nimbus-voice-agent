"""Text-to-speech across providers (OpenAI, Gemini, ElevenLabs).

Returns synthesized audio bytes + media type + server-side synthesis latency
(tts_ms). Playback buffering happens client-side so its added latency is visible.
"""
from __future__ import annotations

import base64
import os
import time

import httpx

from app import audio

_TIMEOUT = httpx.Timeout(60.0, connect=10.0)

PROVIDERS = ("openai", "gemini", "elevenlabs")
_OPENAI_MODEL = "gpt-4o-mini-tts"
_GEMINI_MODEL = "gemini-2.5-flash-preview-tts"
_ELEVEN_MODEL = "eleven_turbo_v2_5"

# voice options surfaced to the frontend.
VOICES = {
    "openai": ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
    "gemini": ["Kore", "Puck", "Charon", "Aoede", "Fenrir"],
    "elevenlabs": ["Sarah", "Roger", "Laura"],
}
_ELEVEN_VOICE_IDS = {
    "Sarah": "EXAVITQu4vr4xnSDxMaL",
    "Roger": "CwhRBWXzGAHq8TQ4Fs17",
    "Laura": "FGY2WhTYpPnrIDTdsKH5",
}


def _key(provider: str, override: str | None) -> str:
    env = {"openai": "OPENAI_API_KEY", "gemini": "GEMINI_API_KEY", "elevenlabs": "ELEVENLABS_API_KEY"}[provider]
    key = override or os.getenv(env)
    if not key:
        raise RuntimeError(f"Missing {provider} API key for TTS.")
    return key


def _default_voice(provider: str, voice: str | None) -> str:
    return voice if voice and voice in (VOICES[provider] + list(_ELEVEN_VOICE_IDS)) else VOICES[provider][0]


def _openai(text: str, voice: str, key: str) -> tuple[bytes, str]:
    r = httpx.post(
        "https://api.openai.com/v1/audio/speech",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={"model": _OPENAI_MODEL, "voice": voice, "input": text, "response_format": "mp3"},
        timeout=_TIMEOUT,
    )
    if r.status_code != 200:
        raise RuntimeError(f"OpenAI TTS error {r.status_code}: {r.text[:200]}")
    return r.content, "audio/mpeg"


def _elevenlabs(text: str, voice: str, key: str) -> tuple[bytes, str]:
    vid = _ELEVEN_VOICE_IDS.get(voice, list(_ELEVEN_VOICE_IDS.values())[0])
    r = httpx.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{vid}",
        headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
        json={"text": text, "model_id": _ELEVEN_MODEL},
        timeout=_TIMEOUT,
    )
    if r.status_code != 200:
        raise RuntimeError(f"ElevenLabs TTS error {r.status_code}: {r.text[:200]}")
    return r.content, "audio/mpeg"


def _gemini(text: str, voice: str, key: str) -> tuple[bytes, str]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{_GEMINI_MODEL}:generateContent?key={key}"
    body = {
        "contents": [{"parts": [{"text": text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
        },
    }
    r = httpx.post(url, json=body, timeout=_TIMEOUT)
    if r.status_code != 200:
        raise RuntimeError(f"Gemini TTS error {r.status_code}: {r.text[:200]}")
    part = r.json()["candidates"][0]["content"]["parts"][0]
    pcm = base64.b64decode(part["inlineData"]["data"])
    return audio.pcm_to_wav(pcm, sample_rate=24000), "audio/wav"


def synthesize(text: str, provider: str, voice: str | None = None, api_key: str | None = None) -> dict:
    if provider not in PROVIDERS:
        raise ValueError(f"Unknown TTS provider '{provider}'. Use one of {PROVIDERS}.")
    text = (text or "").strip()
    if not text:
        raise ValueError("Empty text for TTS.")
    v = _default_voice(provider, voice)
    key = _key(provider, api_key)
    t0 = time.perf_counter()
    data, media = {"openai": _openai, "gemini": _gemini, "elevenlabs": _elevenlabs}[provider](text, v, key)
    return {"audio": data, "media_type": media, "voice": v,
            "tts_ms": round((time.perf_counter() - t0) * 1000.0, 2)}
