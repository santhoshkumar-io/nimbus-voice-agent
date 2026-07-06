"""Split the scraped markdown docs into retrieval chunks.

Each doc is split on markdown headings into sections; oversized sections are
windowed with overlap. Every chunk keeps its source doc + nearest heading so
retrieval results and the visualization can be labeled.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from app import config

MAX_CHARS = 900
OVERLAP = 120


@dataclass(frozen=True)
class Chunk:
    id: int
    doc: str
    heading: str
    text: str

    def as_dict(self) -> dict:
        return {"id": self.id, "doc": self.doc, "heading": self.heading, "text": self.text}

    def embed_text(self) -> str:
        # Prepend heading/doc so the embedding carries topical context.
        return f"{self.doc} - {self.heading}\n{self.text}".strip()


def _sections(md: str) -> list[tuple[str, str]]:
    """Yield (heading, body) sections split on '#'-prefixed lines."""
    sections, heading, buf = [], "", []
    for line in md.splitlines():
        if line.lstrip().startswith("#"):
            if buf:
                sections.append((heading, "\n".join(buf).strip()))
                buf = []
            heading = line.lstrip("#").strip()
        else:
            buf.append(line)
    if buf:
        sections.append((heading, "\n".join(buf).strip()))
    return [(h, b) for h, b in sections if b]


def _window(text: str) -> list[str]:
    if len(text) <= MAX_CHARS:
        return [text]
    out, start = [], 0
    while start < len(text):
        end = min(start + MAX_CHARS, len(text))
        out.append(text[start:end])
        if end == len(text):
            break
        start = end - OVERLAP
    return out


def build_chunks(docs_dir: Path | None = None) -> list[Chunk]:
    docs_dir = docs_dir or config.DOCS_DIR
    files = sorted(docs_dir.glob("*.md")) + sorted((docs_dir / "products").glob("*.md"))
    chunks: list[Chunk] = []
    cid = 0
    for f in files:
        doc = f.stem
        for heading, body in _sections(f.read_text(encoding="utf-8")):
            for piece in _window(body):
                chunks.append(Chunk(cid, doc, heading or doc, piece))
                cid += 1
    return chunks
