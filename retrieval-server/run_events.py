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

from psycopg.types.json import Json

logger = logging.getLogger(__name__)

TABLE = "run_events"
_pool = None

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


async def elapsed_ms(run_id: str) -> int | None:
    """How long the run's turn has been going, in the activity log's own time
    (`at`: ms since the turn started, pauses excluded): the newest activity
    event's `at` plus how long ago it was written. A reattaching client starts
    its thinking timer here instead of at its last-seen event. While the run
    waits on a human the clock is stopped, so nothing is added. None before
    the first activity event."""
    async with _pool.connection() as conn:
        cur = await conn.execute(
            f"""
            SELECT seq,
                   (event->'activity'->>'at')::bigint AS at,
                   (EXTRACT(EPOCH FROM (now() - created_at)) * 1000)::bigint AS age_ms
            FROM {TABLE}
            WHERE run_id = %s AND event ? 'activity'
              AND jsonb_typeof(event->'activity'->'at') = 'number'
            ORDER BY seq DESC
            LIMIT 1
            """,
            (run_id,),
        )
        row = await cur.fetchone()
        if row is None:
            return None
        cur = await conn.execute(
            f"SELECT EXISTS (SELECT 1 FROM {TABLE} WHERE run_id = %s AND seq > %s"
            f" AND event ? 'awaiting_input') AS paused",
            (run_id, row["seq"]),
        )
        paused = (await cur.fetchone())["paused"]
        return int(row["at"]) + (0 if paused else max(0, int(row["age_ms"])))


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
    """Drop a run's events (cancel)."""
    async with _pool.connection() as conn:
        await conn.execute(f"DELETE FROM {TABLE} WHERE run_id = %s", (run_id,))
