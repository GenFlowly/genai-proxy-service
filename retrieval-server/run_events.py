"""
Poll-based reattach channel for durable runs (see DURABLE_AGENTS_DBOS_PLAN §5.6).

Each durable run appends its outbound stream events to a Postgres table keyed by
(run_id, seq) with a per-run monotonic seq. The SSE endpoint tails the table with
a short poll (SELECT ... WHERE run_id=? AND seq > ? ORDER BY seq); a reconnecting
client passes the last seq it saw and we replay from there, then keep tailing.

Polling — not LISTEN/NOTIFY — because the Supabase session pooler has no working
NOTIFY (P0 spike). The table shares the checkpointer's connection pool, handed in
by durable_runtime.startup().
"""
import logging

import psycopg.errors
from psycopg.types.json import Json

logger = logging.getLogger(__name__)

TABLE = "run_events"
_pool = None

# User-facing text for runs that end without finishing (plan 0.2, contract C5).
# error_type "run_lost": dead-lettered after repeated crashes, or stranded by a
# deploy that changed the DBOS app version. "error": the workflow itself failed.
RUN_LOST_MESSAGE = (
    "This response was interrupted by a server restart and could not be "
    "completed. Please try again."
)
RUN_FAILED_MESSAGE = "This response failed because of a server error. Please try again."

_CREATE_SQL = f"""
CREATE TABLE IF NOT EXISTS {TABLE} (
    run_id     TEXT        NOT NULL,
    seq        BIGINT      NOT NULL,
    event      JSONB       NOT NULL,
    terminal   BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, seq)
);
"""


async def setup(pool) -> None:
    """Create the events table and remember the pool. Called once on startup
    (durable_runtime.startup) before any run can publish."""
    global _pool
    _pool = pool
    async with pool.connection() as conn:
        await conn.execute(_CREATE_SQL)
    logger.info("run_events table ready")


async def publish(run_id: str, event: dict, terminal: bool = False) -> int:
    """Append one event to the run's ordered channel; returns its assigned seq.
    There is a single writer per run (the agent_run workflow, which awaits each
    publish in order), so computing MAX(seq)+1 inline is race-free per run_id.
    `terminal=True` marks the last event so the SSE tailer can close cleanly."""
    async with _pool.connection() as conn:
        cur = await conn.execute(
            f"""
            INSERT INTO {TABLE} (run_id, seq, event, terminal)
            VALUES (
                %s,
                (SELECT COALESCE(MAX(seq), 0) + 1 FROM {TABLE} WHERE run_id = %s),
                %s, %s
            )
            RETURNING seq
            """,
            (run_id, run_id, Json(event), terminal),
        )
        row = await cur.fetchone()
        return row["seq"]


def failure_events(run_id: str, error: str, error_type: str) -> list[dict]:
    """The rows that end a failed run (contract C5): first a standalone,
    non-terminal error row with no other keys — the proxy's parser takes the
    first key it recognises, so an error inside a summary that also carries
    other keys can be missed — then the terminal summary."""
    return [
        {"error": error, "error_type": error_type},
        {"status": "error", "run_id": run_id, "error": error, "error_type": error_type},
    ]


class _AlreadyTerminal(Exception):
    """A terminal row exists — roll the transaction back, nothing to add."""


async def publish_terminal_once(run_id: str, events: list[dict]) -> bool:
    """Append `events` to the run's channel, the last one terminal, unless the
    run already has a terminal row. For writers other than the run itself —
    the sweep ending a dead-lettered, failed or stranded run — so running it
    twice, or concurrently, adds the rows once. Returns True if it wrote them.

    Each insert is guarded by WHERE NOT EXISTS (a terminal row); a primary-key
    conflict on (run_id, seq) means another writer appended concurrently,
    which counts as done. All rows commit together or not at all."""
    if not events:
        return False
    try:
        async with _pool.connection() as conn:
            async with conn.transaction():
                for i, event in enumerate(events):
                    cur = await conn.execute(
                        f"""
                        INSERT INTO {TABLE} (run_id, seq, event, terminal)
                        SELECT %s,
                               (SELECT COALESCE(MAX(seq), 0) + 1 FROM {TABLE} WHERE run_id = %s),
                               %s, %s
                        WHERE NOT EXISTS (SELECT 1 FROM {TABLE} WHERE run_id = %s AND terminal)
                        """,
                        (run_id, run_id, Json(event), i == len(events) - 1, run_id),
                    )
                    if cur.rowcount == 0:
                        raise _AlreadyTerminal()
    except (_AlreadyTerminal, psycopg.errors.UniqueViolation):
        return False
    return True


async def read_since(run_id: str, from_seq: int = 0, limit: int = 500) -> list[dict]:
    """Rows with seq > from_seq, oldest first. Each row: {seq, event, terminal}.
    The SSE endpoint calls this in a loop, advancing from_seq, so `limit` just
    paginates a fast catch-up — it never drops events."""
    async with _pool.connection() as conn:
        cur = await conn.execute(
            f"""
            SELECT seq, event, terminal FROM {TABLE}
            WHERE run_id = %s AND seq > %s
            ORDER BY seq
            LIMIT %s
            """,
            (run_id, from_seq, limit),
        )
        return await cur.fetchall()


async def latest_seq(run_id: str) -> int:
    """Highest seq published for a run (0 if none) — for status/rediscovery."""
    async with _pool.connection() as conn:
        cur = await conn.execute(
            f"SELECT COALESCE(MAX(seq), 0) AS s FROM {TABLE} WHERE run_id = %s",
            (run_id,),
        )
        row = await cur.fetchone()
        return row["s"]


async def delete_run(run_id: str) -> None:
    """Drop a run's events (cancel / TTL cleanup)."""
    async with _pool.connection() as conn:
        await conn.execute(f"DELETE FROM {TABLE} WHERE run_id = %s", (run_id,))


async def delete_older_than(max_age_seconds: int) -> int:
    """Prune events older than max_age_seconds (run TTL); returns rows deleted.
    Idempotent, so multiple pruners running concurrently is harmless."""
    async with _pool.connection() as conn:
        cur = await conn.execute(
            f"DELETE FROM {TABLE} WHERE created_at < now() - make_interval(secs => %s)",
            (max_age_seconds,),
        )
        return cur.rowcount
