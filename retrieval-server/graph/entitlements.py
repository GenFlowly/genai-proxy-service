"""Customer entitlements: which features the customer's stored credentials
make possible. The proxy server sends them with each request, and tools that
need a setting the customer lacks are dropped before the model sees them, the
same bind-time gate memory consent uses.

None means the caller sent no entitlements (voice, an older proxy). Nothing is
dropped then, and each tool discovers a missing setting itself.
"""
from typing import Iterable, Optional

# Embed the query and search the customer's vector DB.
VECTOR_SEARCH_TOOLS = frozenset({"search_knowledge_base", "search_memories"})
WEB_SEARCH_TOOLS = frozenset({"web_search"})


def can_search_vectors(entitlements: Optional[dict]) -> bool:
    if entitlements is None:
        return True
    return bool(entitlements.get("is_vector_db_storing_enabled")) and bool(
        entitlements.get("is_embedding_creation_enabled")
    )


def can_search_web(entitlements: Optional[dict]) -> bool:
    if entitlements is None:
        return True
    return bool(entitlements.get("is_web_search_enabled"))


def entitled_tools(names: Iterable[str], entitlements: Optional[dict]) -> list[str]:
    """names, in order, without the tools the customer can't use."""
    blocked: set[str] = set()
    if not can_search_vectors(entitlements):
        blocked |= VECTOR_SEARCH_TOOLS
    if not can_search_web(entitlements):
        blocked |= WEB_SEARCH_TOOLS
    return [name for name in names if name not in blocked]
