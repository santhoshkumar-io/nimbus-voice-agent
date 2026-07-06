"""Tool registry: JSON-schema specs + dispatch + provider-format conversion.

A ToolSpec carries the schema shown to the LLM and a handler. `needs_session`
marks tools that operate on the per-session cart (the session_id is injected by
the orchestrator, not by the model).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from app.tools import handlers as H


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict          # JSON schema (properties the model fills)
    handler: Callable
    needs_session: bool


def _schema(props: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": props, "required": required or []}


_NONE = _schema({})

TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec("add_to_cart",
             "Add a product (and optional tier + seat count) to the cart.",
             _schema({"product": {"type": "string", "description": "Product name or id, e.g. 'Nimbus CRM' or 'crm'."},
                      "tier": {"type": "string", "description": "Tier name like Starter/Professional. Optional."},
                      "seats": {"type": "integer", "description": "Number of seats. Default 1."}},
                     ["product"]),
             H.add_to_cart, True),
    ToolSpec("cart_total", "Get the cart's current monthly total and line items.",
             _NONE, H.cart_total, True),
    ToolSpec("annual_pricing", "Compute the cart's price billed annually.",
             _NONE, H.annual_pricing, True),
    ToolSpec("savings_annual_vs_monthly",
             "Compute dollar and percentage savings of paying annually vs monthly for the cart.",
             _NONE, H.savings_annual_vs_monthly, True),
    ToolSpec("sort_products", "Sort all products by starting price.",
             _schema({"order": {"type": "string", "enum": ["asc", "desc"],
                                "description": "asc = increasing, desc = decreasing."}}),
             H.sort_products, False),
    ToolSpec("top_k_expensive", "Get the top-k most expensive products by starting price.",
             _schema({"k": {"type": "integer", "description": "How many products. Default 5."}}),
             H.top_k_expensive, False),
    ToolSpec("remove_item", "Remove a single product line from the cart.",
             _schema({"product": {"type": "string"}, "tier": {"type": "string"}}, ["product"]),
             H.remove_item, True),
    ToolSpec("checkout_item", "Check out a single product line from the cart.",
             _schema({"product": {"type": "string"}, "tier": {"type": "string"}}, ["product"]),
             H.checkout_item, True),
    ToolSpec("clear_cart", "Remove all items from the cart.", _NONE, H.clear_cart, True),
    ToolSpec("checkout", "Check out the entire cart.", _NONE, H.checkout, True),
    ToolSpec("product_info", "Look up a product's tiers, prices, and details.",
             _schema({"product": {"type": "string"}}, ["product"]),
             H.product_info, False),
)

_BY_NAME = {t.name: t for t in TOOLS}
ALL_NAMES = tuple(t.name for t in TOOLS)


def list_tools() -> list[dict]:
    return [{"name": t.name, "description": t.description} for t in TOOLS]


def enabled_specs(enabled: list[str] | None) -> list[ToolSpec]:
    if enabled is None:
        return list(TOOLS)
    allow = set(enabled)
    return [t for t in TOOLS if t.name in allow]


def openai_schema(specs: list[ToolSpec]) -> list[dict]:
    return [{"type": "function",
             "function": {"name": t.name, "description": t.description, "parameters": t.parameters}}
            for t in specs]


def gemini_schema(specs: list[ToolSpec]) -> list[dict]:
    decls = []
    for t in specs:
        fn = {"name": t.name, "description": t.description}
        if t.parameters.get("properties"):
            fn["parameters"] = t.parameters
        decls.append(fn)
    return [{"function_declarations": decls}]


def dispatch(name: str, args: dict, session_id: str) -> dict:
    spec = _BY_NAME.get(name)
    if not spec:
        return {"error": f"Unknown tool '{name}'."}
    kwargs = dict(args or {})
    try:
        if spec.needs_session:
            return spec.handler(session_id, **kwargs)
        return spec.handler(**kwargs)
    except TypeError as e:
        return {"error": f"Bad arguments for {name}: {e}"}
    except Exception as e:  # never crash the turn on a tool error
        return {"error": f"Tool {name} failed: {e}"}
