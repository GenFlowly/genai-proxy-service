"""Per-message sharing of lookup results across the parallel runs of one turn.

A multi-model turn is N independent graph runs of the same user message, one
per selected model, and each run decides on its own to search. Their first
searches ask the same question in different words, so paying for every one buys
little. The pool keys shared state by the turn id the proxy sends (the user
message id; absent for regenerations and internal generations, which bypass the
pool) and serves a run's FIRST call to a shareable tool from the results its
siblings already fetched — or are still fetching — instead of executing it.
Every later call from that run executes normally and joins the pool, so "refine
and retry" keeps working, and an identical query is never fetched twice within
a turn by any run.

Only results that carry sources are shared: a failed or empty lookup would
otherwise spread one run's bad luck to every sibling, so those fall back to the
run's own call.

State is in-process: one entry per (turn, tool), bounded and expiring through
BoundedCache so nothing outlives the message by more than the TTL. Waiting on a
sibling's in-flight call goes through a concurrent.futures.Future wrapped for
the waiter's own loop, so runs driven by different event loops interoperate.
"""
import asyncio
import concurrent.futures
import json
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from encoding_library.observability import count, observe
from graph.bounded_cache import BoundedCache
from graph_tools.base import Source, ToolResult

logger = logging.getLogger(__name__)

# Turns are seconds apart; the TTL only has to outlive the slowest sibling's
# first call, and bounds how long a retried message can see earlier results.
_DEFAULT_TTL_SECONDS = 600.0
_DEFAULT_MAX_TURNS = 2000
# Longer than the tools' own upstream timeouts (web_search: 2 × 15 s) so a
# waiter never gives up on a call that is about to return.
_DEFAULT_WAIT_TIMEOUT_SECONDS = 35.0

OUTCOME_EXECUTED = "executed"
OUTCOME_SHARED = "shared"
OUTCOME_DEDUPLICATED = "deduplicated"
OUTCOME_FALLBACK = "fallback"
OUTCOME_BYPASSED = "bypassed"

_WHITESPACE = re.compile(r"\s+")


def _normalize(value):
    if isinstance(value, str):
        return _WHITESPACE.sub(" ", value.strip().lower())
    if isinstance(value, list):
        return sorted(_normalize(v) for v in value if v not in (None, ""))
    if isinstance(value, dict):
        return {k: _normalize(v) for k, v in sorted(value.items()) if v not in (None, "", [])}
    return value


# Arguments that explain a call to the user but never change what it fetches.
_NON_FETCH_ARGS = frozenset({"purpose"})


def args_key(args: dict) -> str:
    """Two calls with the same key would fetch the same thing: argument order,
    case, whitespace and the explanatory `purpose` do not count."""
    fetch_args = {k: v for k, v in (args or {}).items() if k not in _NON_FETCH_ARGS}
    return json.dumps(_normalize(fetch_args), sort_keys=True, default=str)


def _describe(args: dict) -> str:
    query = (args or {}).get("query")
    if isinstance(query, str) and query.strip():
        return query.strip()
    return json.dumps(args or {}, sort_keys=True, default=str)


@dataclass
class _Fetch:
    run_id: str
    key: str
    args: dict
    future: concurrent.futures.Future = field(default_factory=concurrent.futures.Future)

    def shareable_result(self) -> ToolResult | None:
        if not self.future.done() or self.future.cancelled() or self.future.exception() is not None:
            return None
        result = self.future.result()
        return result if result is not None and result.sources else None


@dataclass
class _TurnEntry:
    lock: threading.Lock = field(default_factory=threading.Lock)
    fetches: list = field(default_factory=list)
    served_runs: set = field(default_factory=set)

    def find(self, key: str) -> _Fetch | None:
        return next((f for f in self.fetches if f.key == key), None)


def _merge_sources(results: list[ToolResult]) -> list[Source]:
    seen: set[str] = set()
    merged: list[Source] = []
    for result in results:
        for s in result.sources:
            marker = s.url or f"{s.title}|{s.content[:80]}"
            if marker in seen:
                continue
            seen.add(marker)
            merged.append(s)
    return merged


def _shared_preamble(tool_name: str, queries: list[str], own: str, deduplicated: bool) -> str:
    if deduplicated:
        return (
            f"Results for '{own}' (already fetched by {tool_name} for this message; "
            "identical request, not re-run). Base your answer on the sources below."
        )
    listed = "; ".join(f"'{q}'" for q in queries)
    return (
        f"{tool_name} results already gathered for this message by a parallel run "
        f"(queries: {listed}). Your query was '{own}'. Base your answer on the sources "
        "below. If a specific fact your query targeted is missing from them, call "
        f"{tool_name} once more with ONE refined query naming exactly that fact."
    )


class LookupPool:
    def __init__(
        self,
        max_turns: int = _DEFAULT_MAX_TURNS,
        ttl_seconds: float = _DEFAULT_TTL_SECONDS,
        wait_timeout: float = _DEFAULT_WAIT_TIMEOUT_SECONDS,
    ):
        self._entries: BoundedCache = BoundedCache(max_size=max_turns, ttl_seconds=ttl_seconds)
        self._entries_lock = threading.Lock()
        self._wait_timeout = wait_timeout

    def _entry(self, turn_id: str, tool_name: str) -> _TurnEntry:
        key = (turn_id, tool_name)
        with self._entries_lock:
            entry = self._entries.get(key)
            if entry is None:
                entry = _TurnEntry()
                self._entries.set(key, entry)
            return entry

    async def execute(
        self,
        turn_id: str | None,
        tool_name: str,
        run_id: str,
        args: dict,
        execute: Callable[[], Awaitable[ToolResult]],
    ) -> tuple[ToolResult, str]:
        """Serve one tool call for `run_id` within `turn_id`, executing it only
        when no sibling result can stand in for it. Returns the result and the
        outcome label (OUTCOME_*). Exceptions from `execute` propagate after
        the pool has forgotten the failed fetch."""
        if not turn_id:
            result = await execute()
            count("lookup_pool_total", tool=tool_name, status=OUTCOME_BYPASSED)
            return result, OUTCOME_BYPASSED

        entry = self._entry(turn_id, tool_name)
        key = args_key(args)
        with entry.lock:
            duplicate = entry.find(key)
            first_call = run_id not in entry.served_runs
            entry.served_runs.add(run_id)
            if duplicate is not None:
                targets, outcome = [duplicate], OUTCOME_DEDUPLICATED
            elif first_call and entry.fetches:
                targets, outcome = list(entry.fetches), OUTCOME_SHARED
            else:
                targets, outcome = [], OUTCOME_EXECUTED
                fetch = _Fetch(run_id=run_id, key=key, args=dict(args or {}))
                entry.fetches.append(fetch)

        if not targets:
            result = await self._run_fetch(entry, fetch, execute)
            count("lookup_pool_total", tool=tool_name, status=OUTCOME_EXECUTED)
            return result, OUTCOME_EXECUTED

        started = time.perf_counter()
        usable = await self._await_targets(targets)
        observe("lookup_pool_wait_duration_seconds", time.perf_counter() - started, tool=tool_name)
        if usable:
            return self._serve(tool_name, turn_id, args, usable, outcome)

        # The sibling call failed, returned nothing citable or timed out, so
        # this run fetches for itself and its result joins the pool — unless a
        # sibling's own fallback for the same request is already in flight.
        with entry.lock:
            inflight = entry.find(key)
            if inflight is not None and not inflight.future.done():
                fetch = None
            else:
                fetch = _Fetch(run_id=run_id, key=key, args=dict(args or {}))
                entry.fetches = [f for f in entry.fetches if f.key != key] + [fetch]
        if fetch is not None:
            result = await self._run_fetch(entry, fetch, execute)
            count("lookup_pool_total", tool=tool_name, status=OUTCOME_FALLBACK)
            return result, OUTCOME_FALLBACK
        usable = await self._await_targets([inflight])
        if usable:
            return self._serve(tool_name, turn_id, args, usable, OUTCOME_DEDUPLICATED)
        result = await execute()
        count("lookup_pool_total", tool=tool_name, status=OUTCOME_FALLBACK)
        return result, OUTCOME_FALLBACK

    @staticmethod
    def _serve(tool_name, turn_id, args, usable, outcome) -> tuple[ToolResult, str]:
        queries = [_describe(f.args) for f, _ in usable]
        result = ToolResult(
            content=_shared_preamble(
                tool_name, queries, _describe(args), outcome == OUTCOME_DEDUPLICATED
            ),
            sources=_merge_sources([r for _, r in usable]),
            details={"pool": outcome, "queries": queries},
        )
        count("lookup_pool_total", tool=tool_name, status=outcome)
        logger.info(
            "lookup_pool: %s call %s from %d sibling result(s) (turn=%s)",
            tool_name, outcome, len(usable), turn_id,
        )
        return result, outcome

    @staticmethod
    async def _run_fetch(entry: _TurnEntry, fetch: _Fetch, execute) -> ToolResult:
        try:
            result = await execute()
        except BaseException as e:
            with entry.lock:
                entry.fetches = [f for f in entry.fetches if f is not fetch]
            if not fetch.future.done():
                fetch.future.set_exception(e)
            raise
        if not fetch.future.done():
            fetch.future.set_result(result)
        return result

    async def _await_targets(self, targets: list) -> list[tuple[_Fetch, ToolResult]]:
        usable: list[tuple[_Fetch, ToolResult]] = []
        for fetch in targets:
            if fetch is None:
                continue
            if not fetch.future.done():
                try:
                    await asyncio.wait_for(
                        asyncio.shield(asyncio.wrap_future(fetch.future)), self._wait_timeout
                    )
                except Exception:
                    pass
            result = fetch.shareable_result()
            if result is not None:
                usable.append((fetch, result))
        return usable


lookup_pool = LookupPool()
