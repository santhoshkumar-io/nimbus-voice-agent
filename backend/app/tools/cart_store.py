"""In-memory per-session cart, mirroring the site cart shape so it can later sync
to localStorage `nimbus_cart`.

Item shape: {product_id, product_name, tier, seats, price_monthly, price_annual_monthly}

Operations return new lists (no in-place mutation) and store the new list.
"""
from __future__ import annotations

_carts: dict[str, list[dict]] = {}


def get(session_id: str) -> list[dict]:
    return list(_carts.get(session_id, []))


def _set(session_id: str, items: list[dict]) -> list[dict]:
    _carts[session_id] = items
    return list(items)


def clear(session_id: str) -> list[dict]:
    return _set(session_id, [])


def add(session_id: str, item: dict, seats: int) -> list[dict]:
    items = get(session_id)
    idx = next(
        (i for i, it in enumerate(items)
         if it["product_id"] == item["product_id"] and it["tier"] == item["tier"]),
        None,
    )
    if idx is None:
        items = items + [{**item, "seats": seats}]
    else:
        merged = {**items[idx], "seats": items[idx]["seats"] + seats}
        items = items[:idx] + [merged] + items[idx + 1:]
    return _set(session_id, items)


def find_index(session_id: str, product_id: str, tier: str | None) -> int | None:
    items = get(session_id)
    for i, it in enumerate(items):
        if it["product_id"] == product_id and (tier is None or it["tier"] == tier):
            return i
    return None


def remove_at(session_id: str, idx: int) -> tuple[dict, list[dict]]:
    items = get(session_id)
    removed = items[idx]
    items = items[:idx] + items[idx + 1:]
    _set(session_id, items)
    return removed, items
