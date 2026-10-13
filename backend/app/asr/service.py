"""Speech-to-text across providers. The browser provider is handled client-side
(Web Speech API); here we serve OpenAI, Gemini, and ElevenLabs.

Input audio is transcoded to 16 kHz mono WAV first so every provider gets a
format it accepts. Returns transcript + asr_ms.

Language: callers pass an ISO-639-1 code (e.g. "en") to pin recognition, or
"auto" to let the provider detect. Pinning avoids short/accented English clips
being misdetected as another language (e.g. Tamil).
"""
from __future__ import annotations

import base64
import os
import re
import time

import httpx

from app import audio

# Non-speech event tags providers may still emit: "(footsteps)", "[laughter]", "*sighs*".
_NONSPEECH_RE = re.compile(r"[\(\[\{\*][^\)\]\}\*]*[\)\]\}\*]")
_WORD_RE = re.compile(r"[^\W_]", re.UNICODE)


def _clean_transcript(text: str) -> str:
    """Drop bracketed/starred audio-event tags; return "" if nothing speech-like remains."""
    stripped = re.sub(r"\s+", " ", _NONSPEECH_RE.sub(" ", text)).strip()
    return stripped if _WORD_RE.search(stripped) else ""

_TIMEOUT = httpx.Timeout(60.0, connect=10.0)

PROVIDERS = ("openai", "gemini", "elevenlabs")
_OPENAI_MODEL = "gpt-4o-transcribe"
_GEMINI_MODEL = "gemini-3.5-flash"  # 2.5-flash retired 2026-10 (404)
_ELEVEN_MODEL = "scribe_v1"

DEFAULT_LANGUAGE = "en"
AUTO = "auto"

# ISO-639-1 -> human name, for the Gemini prompt (which is text-instructed).
_LANG_NAMES = {
    "en": "English", "ta": "Tamil", "hi": "Hindi", "te": "Telugu", "ml": "Malayalam",
    "kn": "Kannada", "es": "Spanish", "fr": "French", "de": "German", "ja": "Japanese",
    "zh": "Chinese", "ar": "Arabic", "pt": "Portuguese", "ru": "Russian",
}


def _norm_lang(language: str | None) -> str | None:
    """Return a normalized ISO-639-1 code, or None to mean auto-detect."""
    if not language:
        return DEFAULT_LANGUAGE
    lang = language.strip().lower()
    if lang in ("", AUTO):
        return None
    return lang


def _key(provider: str, override: str | None) -> str:
    env = {"openai": "OPENAI_API_KEY", "gemini": "GEMINI_API_KEY", "elevenlabs": "ELEVENLABS_API_KEY"}[provider]
    key = override or os.getenv(env)
    if not key:
        raise RuntimeError(f"Missing {provider} API key for ASR.")
    return key


def _openai(wav: bytes, key: str, lang: str | None) -> str:
    data = {"model": _OPENAI_MODEL, "response_format": "json"}
    if lang:  # ISO-639-1
        data["language"] = lang
    r = httpx.post(
        "https://api.openai.com/v1/audio/transcriptions",
        headers={"Authorization": f"Bearer {key}"},
        files={"file": ("audio.wav", wav, "audio/wav")},
        data=data,
        timeout=_TIMEOUT,
    )
    if r.status_code != 200:
        raise RuntimeError(f"OpenAI ASR error {r.status_code}: {r.text[:200]}")
    return r.json().get("text", "").strip()


def _elevenlabs(wav: bytes, key: str, lang: str | None) -> str:
    # tag_audio_events=false stops Scribe from transcribing non-speech sounds as
    # "(footsteps)", "(laughter)", etc. For a voice agent we only want speech.
    data = {"model_id": _ELEVEN_MODEL, "tag_audio_events": "false", "diarize": "false"}
    if lang:  # scribe accepts ISO-639-1 or ISO-639-3
        data["language_code"] = lang
    r = httpx.post(
        "https://api.elevenlabs.io/v1/speech-to-text",
        headers={"xi-api-key": key},
        files={"file": ("audio.wav", wav, "audio/wav")},
        data=data,
        timeout=_TIMEOUT,
    )
    if r.status_code != 200:
        raise RuntimeError(f"ElevenLabs ASR error {r.status_code}: {r.text[:200]}")
    return r.json().get("text", "").strip()


def _gemini(wav: bytes, key: str, lang: str | None) -> str:
    if lang:
        name = _LANG_NAMES.get(lang, lang)
        instr = (
            f"Transcribe this audio verbatim. The speaker is talking in {name}. "
            f"Transcribe the speech in {name} using the {name} script only. "
            "Return only the transcript text."
        )
    else:
        instr = "Transcribe this audio verbatim. Return only the transcript text."
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{_GEMINI_MODEL}:generateContent?key={key}"
    body = {
        "contents": [{"role": "user", "parts": [
            {"text": instr},
            {"inline_data": {"mime_type": "audio/wav", "data": base64.b64encode(wav).decode()}},
        ]}]
    }
    r = httpx.post(url, json=body, timeout=_TIMEOUT)
    if r.status_code != 200:
        raise RuntimeError(f"Gemini ASR error {r.status_code}: {r.text[:200]}")
    cand = (r.json().get("candidates") or [{}])[0]
    parts = cand.get("content", {}).get("parts", [])
    return "".join(p.get("text", "") for p in parts).strip()


def transcribe(raw_audio: bytes, provider: str, api_key: str | None = None,
               language: str | None = DEFAULT_LANGUAGE) -> dict:
    if provider not in PROVIDERS:
        raise ValueError(f"Unknown ASR provider '{provider}'. Use one of {PROVIDERS}.")
    t0 = time.perf_counter()
    wav = audio.to_wav(raw_audio)
    key = _key(provider, api_key)
    lang = _norm_lang(language)
    raw = {"openai": _openai, "gemini": _gemini, "elevenlabs": _elevenlabs}[provider](wav, key, lang)
    text = _clean_transcript(raw)
    return {
        "text": text,
        "asr_ms": round((time.perf_counter() - t0) * 1000.0, 2),
        "provider": provider,
        "language": lang or AUTO,
    }
