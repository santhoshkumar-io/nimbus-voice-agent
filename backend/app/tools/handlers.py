"""The 11 tool handlers. Each takes (session_id, **args) and returns a JSON-safe
dict. Pricing is computed from catalog tiers; cart math never mutates in place.
"""
from __future__ import annotations

from app.tools import cart_store as cart
from app.tools import catalog_data as cat

ANNUAL_DISCOUNT_LABEL = "Annual plans receive a 20 percent discount."


def _money(v: float) -> str:
    return f"${v:.0f}" if v == int(v) else f"${v:.2f}"


def _line(it: dict) -> dict:
    monthly = it["price_monthly"] * it["seats"]
    annual_monthly = it["price_annual_monthly"] * it["seats"]
    return {
        "product": it["product_name"], "tier": it["tier"], "seats": it["seats"],
        "monthly": monthly, "annual_per_month": annual_monthly,
    }


def _cart_view(session_id: str) -> dict:
    items = cart.get(session_id)
    return {"items": [_line(i) for i in items],
            "count": sum(i["seats"] for i in items),
            "monthly_total": sum(i["price_monthly"] * i["seats"] for i in items)}


# ---- 1. cart total ----
def cart_total(session_id: str) -> dict:
    v = _cart_view(session_id)
    if not v["items"]:
        return {"empty": True, "message": "The cart is empty."}
    return {"monthly_total": v["monthly_total"], "items": v["items"], "count": v["count"],
            "message": f"Monthly total is {_money(v['monthly_total'])} across {len(v['items'])} app(s)."}


# ---- 2. add to cart ----
def add_to_cart(session_id: str, product: str, tier: str | None = None, seats: int = 1) -> dict:
    p = cat.resolve_product(product)
    if not p:
        return {"error": f"No product matches '{product}'."}
    t = cat.resolve_tier(p, tier)
    if not t:
        return {"error": f"No tier '{tier}' for {p['name']}."}
    seats = max(1, int(seats or 1))
    item = {
        "product_id": p["id"], "product_name": p["name"], "tier": t["name"],
        "price_monthly": float(t.get("priceMonthly") or 0),
        "price_annual_monthly": float(t.get("priceAnnualMonthly") or t.get("priceMonthly") or 0),
    }
    cart.add(session_id, item, seats)
    return {"added": {"product": p["name"], "tier": t["name"], "seats": seats},
            "cart": _cart_view(session_id),
            "message": f"Added {seats} seat(s) of {p['name']} ({t['name']})."}


# ---- 3. checkout whole cart ----
def checkout(session_id: str) -> dict:
    v = _cart_view(session_id)
    if not v["items"]:
        return {"error": "The cart is empty; nothing to check out."}
    order_id = _order_id(session_id, len(v["items"]))
    cart.clear(session_id)
    return {"order_id": order_id, "monthly_total": v["monthly_total"], "items": v["items"],
            "message": f"Order {order_id} confirmed: {_money(v['monthly_total'])}/mo. (Demo, no card charged.)"}


# ---- 4. annual-format pricing of the cart ----
def annual_pricing(session_id: str) -> dict:
    items = cart.get(session_id)
    if not items:
        return {"empty": True, "message": "The cart is empty."}
    annual_total = sum(i["price_annual_monthly"] * i["seats"] * 12 for i in items)
    annual_per_month = sum(i["price_annual_monthly"] * i["seats"] for i in items)
    return {"annual_total": annual_total, "billed_per_month_equivalent": annual_per_month,
            "note": ANNUAL_DISCOUNT_LABEL,
            "message": f"Paid annually, the cart is {_money(annual_total)}/year "
                       f"({_money(annual_per_month)}/mo equivalent)."}


# ---- 5. percentage savings annual vs monthly ----
def savings_annual_vs_monthly(session_id: str) -> dict:
    items = cart.get(session_id)
    if not items:
        return {"empty": True, "message": "The cart is empty."}
    monthly_year = sum(i["price_monthly"] * i["seats"] * 12 for i in items)
    annual_year = sum(i["price_annual_monthly"] * i["seats"] * 12 for i in items)
    saved = monthly_year - annual_year
    pct = (saved / monthly_year * 100) if monthly_year else 0.0
    return {"pay_monthly_per_year": monthly_year, "pay_annual_per_year": annual_year,
            "savings": saved, "savings_percent": round(pct, 1),
            "message": f"Paying annually saves {_money(saved)}/year ({pct:.0f}%) vs monthly."}


# ---- 6. sort products by price ----
def sort_products(order: str = "desc") -> dict:
    asc = str(order).lower().startswith("asc") or "increas" in str(order).lower()
    ranked = sorted(cat.products(), key=cat.starting_price, reverse=not asc)
    return {"order": "ascending" if asc else "descending",
            "products": [{"name": p["name"], "starting_price_monthly": cat.starting_price(p)} for p in ranked]}


# ---- 7. top-k most expensive products ----
def top_k_expensive(k: int = 5) -> dict:
    k = max(1, min(int(k or 5), len(cat.products())))
    ranked = sorted(cat.products(), key=cat.starting_price, reverse=True)[:k]
    return {"k": k, "products": [{"name": p["name"], "starting_price_monthly": cat.starting_price(p)} for p in ranked],
            "message": "Top " + str(k) + " by starting price: " +
                       ", ".join(f"{p['name']} ({_money(cat.starting_price(p))})" for p in ranked)}


# ---- 8. remove one item ----
def remove_item(session_id: str, product: str, tier: str | None = None) -> dict:
    p = cat.resolve_product(product)
    pid = p["id"] if p else product
    idx = cart.find_index(session_id, pid, tier)
    if idx is None:
        return {"error": f"{product} is not in the cart."}
    removed, _ = cart.remove_at(session_id, idx)
    return {"removed": removed["product_name"], "tier": removed["tier"], "cart": _cart_view(session_id),
            "message": f"Removed {removed['product_name']} ({removed['tier']}) from the cart."}


# ---- 9. checkout one item ----
def checkout_item(session_id: str, product: str, tier: str | None = None) -> dict:
    p = cat.resolve_product(product)
    pid = p["id"] if p else product
    idx = cart.find_index(session_id, pid, tier)
    if idx is None:
        return {"error": f"{product} is not in the cart."}
    removed, _ = cart.remove_at(session_id, idx)
    total = removed["price_monthly"] * removed["seats"]
    order_id = _order_id(session_id, 1)
    return {"order_id": order_id, "item": _line(removed), "monthly_total": total,
            "message": f"Checked out {removed['product_name']} ({removed['tier']}) - "
                       f"order {order_id}, {_money(total)}/mo. (Demo.)"}


# ---- 10. clear cart ----
def clear_cart(session_id: str) -> dict:
    n = len(cart.get(session_id))
    cart.clear(session_id)
    return {"cleared": n, "message": f"Cleared the cart ({n} line(s) removed)."}


# ---- 11. product info (grounding helper) ----
def product_info(product: str) -> dict:
    p = cat.resolve_product(product)
    if not p:
        return {"error": f"No product matches '{product}'."}
    return cat.product_summary(p)


def _order_id(session_id: str, n: int) -> str:
    h = abs(hash((session_id, n, len(cart.get(session_id))))) % (36 ** 6)
    base36 = ""
    while h:
        h, r = divmod(h, 36)
        base36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"[r] + base36
    return "NB-" + (base36 or "0").rjust(6, "0")[:6]
