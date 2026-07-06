"""Pure markdown renderers: catalog data in -> markdown string out.

Each function is side-effect free and returns a new string, so the same catalog
can be rendered many ways without mutation. File writing lives in scrape.py.
"""
from __future__ import annotations

from typing import Any

ANNUAL_DISCOUNT_PCT = 20  # from policies.billing ("annual plans receive 20 percent discount")


def _money(v: Any) -> str:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return str(v)
    return f"${int(n)}" if n == int(n) else f"${n:.2f}"


def _bullets(items: list[str]) -> str:
    return "\n".join(f"- {i}" for i in items)


def render_company(company: dict) -> str:
    lines = [f"# {company.get('name', 'Nimbus')} (company)", ""]
    if company.get("legalName"):
        lines.append(f"**Legal name:** {company['legalName']}  ")
    if company.get("tagline"):
        lines.append(f"**Tagline:** {company['tagline']}  ")
    if company.get("founded"):
        lines.append(f"**Founded:** {company['founded']}  ")
    if company.get("hq"):
        lines.append(f"**HQ:** {company['hq']}  ")
    lines.append("")
    for key in ("about", "mission"):
        if company.get(key):
            lines += [f"## {key.title()}", company[key], ""]
    stats = company.get("stats") or {}
    if stats:
        lines.append("## Stats")
        lines += [f"- **{k}:** {v}" for k, v in stats.items()]
        lines.append("")
    contact = company.get("contact") or {}
    if contact:
        lines.append("## Contact")
        lines += [f"- **{k.title()}:** {v}" for k, v in contact.items()]
        lines.append("")
    return "\n".join(lines).strip() + "\n"


def render_families(categories: list[dict], products: list[dict]) -> str:
    lines = ["# Product families (categories)", ""]
    by_cat: dict[str, list[str]] = {}
    for p in products:
        by_cat.setdefault(p.get("categoryId", ""), []).append(p.get("name", ""))
    for c in categories:
        lines.append(f"## {c.get('name')} (`{c.get('id')}`)")
        members = by_cat.get(c.get("id"), [])
        lines.append(_bullets(members) if members else "_No products listed._")
        lines.append("")
    return "\n".join(lines).strip() + "\n"


def _tier_table(tiers: list[dict]) -> str:
    rows = ["| Tier | Monthly | Annual (per mo) | Unit |", "| --- | --- | --- | --- |"]
    for t in tiers:
        mo = _money(t.get("priceMonthly", 0))
        an = _money(t.get("priceAnnualMonthly", t.get("priceMonthly", 0)))
        rows.append(f"| {t.get('name')} | {mo} | {an} | {t.get('unit', '')} |")
    return "\n".join(rows)


def render_product(p: dict) -> str:
    lines = [f"# {p.get('name')}", ""]
    if p.get("tagline"):
        lines.append(f"_{p['tagline']}_")
        lines.append("")
    lines.append(f"**Category:** {p.get('category')} (`{p.get('categoryId')}`)  ")
    lines.append(f"**Product id:** `{p.get('id')}`")
    lines.append("")
    for key in ("summary", "description"):
        if p.get(key):
            lines += [p[key], ""]
    if p.get("keyFeatures"):
        lines += ["## Key features", _bullets(p["keyFeatures"]), ""]
    specs = p.get("specs") or {}
    if specs:
        lines.append("## Specs")
        lines += [f"- **{k}:** {v}" for k, v in specs.items()]
        lines.append("")
    if p.get("integrations"):
        lines += ["## Integrations", _bullets(p["integrations"]), ""]
    if p.get("tiers"):
        lines += ["## Pricing tiers", _tier_table(p["tiers"]), ""]
        for t in p["tiers"]:
            hi = t.get("highlights") or []
            lim = t.get("limits") or {}
            if hi or lim:
                lines.append(f"### {t.get('name')}")
                if hi:
                    lines += [_bullets(hi)]
                if lim:
                    lines += [f"- _Limit:_ **{k}** = {v}" for k, v in lim.items()]
                lines.append("")
    addons = p.get("addOns") or []
    if addons:
        lines.append("## Add-ons")
        for a in addons:
            lines.append(f"- **{a.get('name')}** ({a.get('price')}): {a.get('desc', '')}")
        lines.append("")
    if p.get("faqs"):
        lines.append("## FAQs")
        for f in p["faqs"]:
            lines += [f"**Q: {f.get('q')}**", f"A: {f.get('a')}", ""]
    return "\n".join(lines).strip() + "\n"


def render_pricing(products: list[dict]) -> str:
    lines = [
        "# Pricing (plan model + starting prices)",
        "",
        f"Nimbus bills monthly or annually. Annual plans receive a "
        f"{ANNUAL_DISCOUNT_PCT} percent discount versus paying month to month.",
        "",
        "## Starting price per product",
        "| Product | Lowest paid tier | Monthly | Annual (per mo) |",
        "| --- | --- | --- | --- |",
    ]
    for p in products:
        paid = [t for t in (p.get("tiers") or []) if (t.get("priceMonthly") or 0) > 0]
        if not paid:
            lines.append(f"| {p.get('name')} | Free only | $0 | $0 |")
            continue
        t = min(paid, key=lambda x: x.get("priceMonthly", 0))
        mo = _money(t.get("priceMonthly", 0))
        an = _money(t.get("priceAnnualMonthly", t.get("priceMonthly", 0)))
        lines.append(f"| {p.get('name')} | {t.get('name')} | {mo} | {an} |")
    lines.append("")
    return "\n".join(lines).strip() + "\n"


def render_monthly_vs_annual(products: list[dict]) -> str:
    lines = [
        "# Monthly vs annual billing",
        "",
        f"Annual plans receive a {ANNUAL_DISCOUNT_PCT} percent discount. The table "
        "shows, per paid tier, the yearly cost paid monthly vs paid annually and the "
        "savings.",
        "",
        "| Product | Tier | Monthly x12 | Annual x12 | You save / yr |",
        "| --- | --- | --- | --- | --- |",
    ]
    for p in products:
        for t in p.get("tiers") or []:
            mo = float(t.get("priceMonthly") or 0)
            an = float(t.get("priceAnnualMonthly") or mo)
            if mo <= 0:
                continue
            yearly_monthly = mo * 12
            yearly_annual = an * 12
            saved = yearly_monthly - yearly_annual
            lines.append(
                f"| {p.get('name')} | {t.get('name')} | {_money(yearly_monthly)} "
                f"| {_money(yearly_annual)} | {_money(saved)} |"
            )
    lines.append("")
    return "\n".join(lines).strip() + "\n"


def render_faq(products: list[dict]) -> str:
    lines = ["# Frequently asked questions (all products)", ""]
    for p in products:
        faqs = p.get("faqs") or []
        if not faqs:
            continue
        lines.append(f"## {p.get('name')}")
        for f in faqs:
            lines += [f"**Q: {f.get('q')}**", f"A: {f.get('a')}", ""]
    return "\n".join(lines).strip() + "\n"


_POLICY_TITLES = {
    "refund": "Refund policy",
    "freeTrial": "Free trial",
    "billing": "Billing",
    "cancellation": "Cancellation",
    "sla": "Service level agreement (SLA)",
    "security": "Security and compliance",
    "dataResidency": "Data residency",
    "support": "Support",
}


def render_refund(policies: dict) -> str:
    body = policies.get("refund", "")
    return f"# Refund policy\n\n{body}\n"


def render_terms(policies: dict) -> str:
    """Terms and conditions: every policy block except the standalone refund doc."""
    lines = ["# Terms and conditions / policies", ""]
    for key, title in _POLICY_TITLES.items():
        if key == "refund":
            continue
        if policies.get(key):
            lines += [f"## {title}", policies[key], ""]
    return "\n".join(lines).strip() + "\n"
