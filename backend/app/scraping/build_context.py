"""Concatenate the scraped docs into one big context.md (the RAGless payload).

Order is deliberate: company first, then families, pricing, billing, policies,
FAQ, then every product. A short table of contents is prepended.

Run:  python -m app.scraping.build_context   (after scrape.py)
"""
from __future__ import annotations

from pathlib import Path

from app import config

# Top-level docs in reading order; products are appended after, sorted by id.
_ORDER = [
    "company.md",
    "families.md",
    "pricing.md",
    "monthly-vs-annual.md",
    "refund.md",
    "terms.md",
    "faq.md",
]


def _collect(docs_dir: Path) -> list[Path]:
    ordered = [docs_dir / name for name in _ORDER if (docs_dir / name).exists()]
    product_dir = docs_dir / "products"
    if product_dir.exists():
        ordered += sorted(product_dir.glob("*.md"))
    return ordered


def build_context(docs_dir: Path | None = None, out_path: Path | None = None) -> Path:
    docs_dir = docs_dir or config.DOCS_DIR
    out_path = out_path or config.CONTEXT_PATH
    if not docs_dir.exists():
        raise FileNotFoundError(f"docs dir not found at {docs_dir}; run scrape first")

    parts = _collect(docs_dir)
    sections = [p.read_text(encoding="utf-8").strip() for p in parts]

    toc = "\n".join(
        f"- {p.relative_to(docs_dir)}" for p in parts
    )
    header = (
        "# Nimbus knowledge base (single-file context)\n\n"
        "This file is the full Nimbus corpus concatenated for direct LLM context "
        "(the RAGless path). Sections in order:\n\n"
        f"{toc}\n\n---\n"
    )
    body = "\n\n---\n\n".join(sections)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(header + "\n" + body + "\n", encoding="utf-8")
    return out_path


def main() -> None:
    path = build_context()
    size = path.stat().st_size
    words = len(path.read_text(encoding="utf-8").split())
    print(f"Wrote {path.relative_to(config.BACKEND_DIR)}  "
          f"({size} bytes, ~{words} words)")


if __name__ == "__main__":
    main()
