"""Read-only catalog access + product/tier resolution for the tools.

Prices come straight from catalog.json tiers. The "starting price" of a product
is its lowest paid tier monthly price (matching pricing.md), used for sorting and
top-k. All functions are pure and return new data.
"""
from __future__ import annotations

import json
from functools import lru_cache

from app import config


@lru_cache(maxsize=1)
def _catalog() -> dict:
    with config.CATALOG_PATH.open(encoding="utf-8") as fh:
        return json.load(fh)


def products() -> list[dict]:
    return list(_catalog().get("products", []))


def _norm(s: str) -> str:
    return "".join(c for c in (s or "").lower() if c.isalnum())


def resolve_product(query: str) -> dict | None:
    """Match a product by id, exact name, or fuzzy contains (e.g. 'crm')."""
    if not query:
        return None
    q = _norm(query)
    prods = products()
    for p in prods:  # exact id or name
        if _norm(p["id"]) == q or _norm(p["name"]) == q:
            return p
    # strip a leading "nimbus"
    qq = q[6:] if q.startswith("nimbus") else q
    for p in prods:
        name = _norm(p["name"])
        if name == "nimbus" + qq or name.replace("nimbus", "") == qq:
            return p
    for p in prods:  # substring either direction
        name = _norm(p["name"])
        if qq and (qq in name or name.replace("nimbus", "") in qq):
            return p
    return None


def starting_tier(product: dict) -> dict | None:
    paid = [t for t in product.get("tiers", []) if (t.get("priceMonthly") or 0) > 0]
    if paid:
        return min(paid, key=lambda t: t.get("priceMonthly", 0))
    tiers = product.get("tiers", [])
    return tiers[0] if tiers else None


def starting_price(product: dict) -> float:
    t = starting_tier(product)
    return float(t.get("priceMonthly", 0)) if t else 0.0


def resolve_tier(product: dict, tier_name: str | None) -> dict | None:
    tiers = product.get("tiers", [])
    if not tiers:
        return None
    if not tier_name:
        return starting_tier(product)
    tn = _norm(tier_name)
    for t in tiers:
        if _norm(t.get("name", "")) == tn:
            return t
    for t in tiers:
        if tn and tn in _norm(t.get("name", "")):
            return t
    return None


def product_summary(product: dict) -> dict:
    """Compact, JSON-safe view of a product for tool results."""
    return {
        "id": product["id"],
        "name": product["name"],
        "category": product.get("category"),
        "starting_price_monthly": starting_price(product),
        "tiers": [
            {
                "name": t.get("name"),
                "monthly": float(t.get("priceMonthly") or 0),
                "annual_monthly": float(t.get("priceAnnualMonthly") or t.get("priceMonthly") or 0),
                "unit": t.get("unit"),
            }
            for t in product.get("tiers", [])
        ],
    }
