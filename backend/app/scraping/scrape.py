"""Phase 0 scraper: catalog.json -> structured markdown docs.

Output (under backend/data/docs/):
  company.md, families.md, pricing.md, monthly-vs-annual.md,
  refund.md, terms.md, faq.md, products/<id>.md (one per product)

Run:  python -m app.scraping.scrape
"""
from __future__ import annotations

import json
from pathlib import Path

from app import config
from app.scraping import render


def load_catalog(path: Path | None = None) -> dict:
    src = path or config.CATALOG_PATH
    if not src.exists():
        raise FileNotFoundError(f"catalog.json not found at {src}")
    with src.open(encoding="utf-8") as fh:
        data = json.load(fh)
    for key in ("company", "policies", "categories", "products"):
        if key not in data:
            raise ValueError(f"catalog.json missing required key: {key}")
    return data


def _write(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def build_docs(catalog: dict, docs_dir: Path | None = None) -> list[Path]:
    out_dir = docs_dir or config.DOCS_DIR
    company = catalog["company"]
    policies = catalog["policies"]
    categories = catalog["categories"]
    products = catalog["products"]

    written: list[Path] = [
        _write(out_dir / "company.md", render.render_company(company)),
        _write(out_dir / "families.md", render.render_families(categories, products)),
        _write(out_dir / "pricing.md", render.render_pricing(products)),
        _write(out_dir / "monthly-vs-annual.md", render.render_monthly_vs_annual(products)),
        _write(out_dir / "refund.md", render.render_refund(policies)),
        _write(out_dir / "terms.md", render.render_terms(policies)),
        _write(out_dir / "faq.md", render.render_faq(products)),
    ]
    for p in products:
        pid = p.get("id") or p.get("name", "product")
        written.append(_write(out_dir / "products" / f"{pid}.md", render.render_product(p)))
    return written


def main() -> None:
    catalog = load_catalog()
    written = build_docs(catalog)
    print(f"Scraped {len(catalog['products'])} products into {len(written)} docs:")
    for path in written:
        rel = path.relative_to(config.BACKEND_DIR)
        print(f"  {rel}  ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
