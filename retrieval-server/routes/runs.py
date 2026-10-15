"""
Durable agent-run API (see DURABLE_AGENTS_DBOS_PLAN §5.7). Separate from
/retrieve, which stays the stateless fast path.

  POST /runs                 start a durable run  -> {run_id}
  GET  /runs/{id}/stream     subscribe / reattach (SSE, replay-from-seq)
  POST /runs/{id}/resume     deliver client-tool results / human input (P2)
  POST /runs/{id}/cancel     cancel the workflow + drop its event channel
  GET  /runs/{id}            status / result (polling / rediscovery)
  DELETE /runs/{id}/data     purge everything stored for a finished run (3.9)

The stream tails run_events by polling (the Supabase pooler has no NOTIFY, P0),
so a reconnecting client passes ?from_seq=<last seq it saw> and we replay from
there, then keep tailing. Events are the SAME dict payloads /retrieve emits, so
the proxy's existing SSE→client mapping is unchanged.
"""
import asyncio
import json
import logging
import time
import uuid

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import StreamingResponse

import durable_runtime
import run_events
import runs as runs_module
from graph import pdf_renderer
from models import RunRequest

logger = logging.getLogger(__name__)

router = APIRouter()

# Poll cadence for the reattach tail. Latency floor is bounded by this; kept
# small enough to feel live, large enough not to hammer the pooler.
_POLL_INTERVAL_SEC = 0.4
# Safety cap so a stuck/lost run never tails forever (a run that never publishes
# a terminal row and whose workflow status never goes terminal).
_STREAM_MAX_SEC = 30 * 60
# DBOS workflow statuses that mean "no more events will ever come".
_TERMINAL_STATES = {
    "SUCCESS", "ERROR", "CANCELLED",
    "RETRIES_EXCEEDED", "MAX_RECOVERY_ATTEMPTS_EXCEEDED",
}
# Terminal statuses of a run that FAILED without writing its own terminal row
# (a dead letter writes none; ERROR means the workflow raised first), mapped to
# the error_type the tail reports. The run sweep persists the same rows within
# a minute; the tail writes them at once so a live viewer doesn't wait.
# CANCELLED is deliberately absent — the user asked for it.
_FAILED_STATES = {"MAX_RECOVERY_ATTEMPTS_EXCEEDED": "run_lost", "ERROR": "error"}


def _event_frame(row: dict) -> str:
    return f"id: {row['seq']}\ndata: {json.dumps(row['event'])}\n\n"


def _failure_frames(run_id: str, status: str) -> list[str]:
    """The error frames (contract C5, no SSE id: they are not rows) for a run
    that ended in `status`; none unless it failed."""
    error_type = _FAILED_STATES.get(status)
    if error_type is None:
        return []
    message = run_events.RUN_LOST_MESSAGE if error_type == "run_lost" else run_events.RUN_FAILED_MESSAGE
    return [f"data: {json.dumps(ev)}\n\n" for ev in run_events.failure_events(run_id, message, error_type)]

_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"}
# After this long without writing anything, the tail writes an SSE comment
# line (plan 1.7, contract C4): a run waiting in the queue, being recovered
# after a restart or waiting for human input emits no rows, and the proxy cuts
# a stream that stays silent for 300 s. A comment is skipped by SSE parsers
# (RunsClient reads only data lines) but resets their socket timers, and it is
# never written to run_events.
_KEEPALIVE_SEC = 15.0
_KEEPALIVE_FRAME = ": keepalive\n\n"
# Indirections so tests can drive the tail on a fake clock.
_sleep = asyncio.sleep
_clock = time.monotonic


def _require_ready() -> None:
    if not durable_runtime.is_ready():
        raise HTTPException(status_code=503, detail="durable runs are not available on this server")


async def _status(run_id: str):
    """WorkflowStatus for a run, or None if unknown."""
    from dbos import DBOS

    try:
        handle = await DBOS.retrieve_workflow_async(run_id)
        return await handle.get_status()
    except Exception:
        return None


@router.post("/runs")
async def start_run(req: RunRequest):
    """Enqueue a durable run and return its id immediately; the run executes in
    the background (surviving crashes/redeploys) and is consumed via /stream."""
    _require_ready()
    run_id = req.run_id or f"run_{uuid.uuid4().hex}"
    run_input = req.model_dump(exclude={"run_id"})
    # The PDF renderer is pinned once per turn, BEFORE the run is enqueued
    # (plan 2.1): a recovered run keeps it across an env flip. Caller values
    # are overwritten.
    run_input.update(pdf_renderer.pin(req.customer_id))
    try:
        await runs_module.enqueue_run(run_id, run_input)
    except Exception as e:
        logger.exception("Failed to enqueue run %s", run_id)
        raise HTTPException(status_code=500, detail=f"could not start run: {e}")
    logger.info("Started durable run %s (customer=%s graph_id=%s)", run_id, req.customer_id, req.graph_id)
    return {"run_id": run_id}


@router.get("/runs/{run_id}/stream")
async def stream_run(run_id: str, request: Request, from_seq: int = 0):
    """Tail a run's events as SSE, replaying from `from_seq` (or the
    Last-Event-ID header) so a reconnect resumes exactly where it left off."""
    _require_ready()

    # A browser EventSource auto-sends Last-Event-ID on reconnect; honor it.
    header_id = request.headers.get("last-event-id")
    start_seq = int(header_id) if (header_id and header_id.isdigit()) else from_seq

    async def gen():
        last = start_seq
        waited = 0.0
        last_write = _clock()
        while True:
            if await request.is_disconnected():
                logger.info("Stream %s: client disconnected at seq=%s", run_id, last)
                return
            rows = await run_events.read_since(run_id, last)
            if rows:
                waited = 0.0
                for row in rows:
                    last = row["seq"]
                    yield _event_frame(row)
                    if row["terminal"]:
                        yield "data: [DONE]\n\n"
                        return
                last_write = _clock()
                continue
            # No new events: stop if the workflow is finished (covers a crash
            # that never wrote a terminal row) or if we've tailed too long.
            st = await _status(run_id)
            if st is not None and st.status in _TERMINAL_STATES:
                # One last drain in case events landed between read and status.
                for row in await run_events.read_since(run_id, last):
                    last = row["seq"]
                    yield _event_frame(row)
                    if row["terminal"]:
                        yield "data: [DONE]\n\n"
                        return
                # No terminal row: a failed or dead-lettered run ends with an
                # error the user sees, not a bare [DONE].
                for frame in _failure_frames(run_id, st.status):
                    yield frame
                yield "data: [DONE]\n\n"
                return
            waited += _POLL_INTERVAL_SEC
            if waited >= _STREAM_MAX_SEC:
                # Only a PENDING/ENQUEUED run gets here (e.g. waiting on human
                # input, up to RUN_RESUME_TIMEOUT_SEC): no error frame — the
                # run may still finish, and the proxy re-attaches.
                logger.warning("Stream %s: max duration reached, closing", run_id)
                yield "data: [DONE]\n\n"
                return
            if _clock() - last_write >= _KEEPALIVE_SEC:
                yield _KEEPALIVE_FRAME
                last_write = _clock()
            await _sleep(_POLL_INTERVAL_SEC)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=_SSE_HEADERS)


@router.post("/runs/{run_id}/resume")
async def resume_run(run_id: str, body: dict):
    """Deliver client-tool results / human input to a waiting run. The in-graph
    interrupt()/recv side lands in P2; this endpoint wires the durable delivery
    channel (DBOS.send) now so the proxy contract is stable."""
    _require_ready()
    from dbos import DBOS

    st = await _status(run_id)
    if st is None:
        raise HTTPException(status_code=404, detail="run not found")
    try:
        await DBOS.send_async(run_id, body, topic="resume")
    except Exception as e:
        logger.exception("Failed to deliver resume to run %s", run_id)
        raise HTTPException(status_code=500, detail=f"could not resume run: {e}")
    return {"run_id": run_id, "status": "resume_delivered"}


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str):
    """Cancel the workflow and drop its event channel."""
    _require_ready()
    from dbos import DBOS

    st = await _status(run_id)
    if st is None:
        raise HTTPException(status_code=404, detail="run not found")
    try:
        # The async variant: the sync DBOS.cancel_workflow raises inside a
        # running event loop on dbos 3.x, which made this route return 500.
        await DBOS.cancel_workflow_async(run_id)
    except Exception as e:
        logger.exception("Failed to cancel run %s", run_id)
        raise HTTPException(status_code=500, detail=f"could not cancel run: {e}")
    await run_events.delete_run(run_id)
    logger.info("Cancelled durable run %s", run_id)
    return {"run_id": run_id, "status": "cancelled"}


# DBOS statuses of a run that may still execute and write.
_ACTIVE_STATES = {"PENDING", "ENQUEUED", "DELAYED"}


@router.delete("/runs/{run_id}/data", status_code=204)
async def delete_run_data(run_id: str):
    """Purge everything this service stores for one run (plan 3.9): its DBOS
    rows (the request it was started with, step outputs with the memoized LLM
    responses and tool results, messages, child workflows), its LangGraph
    checkpoints, its run_events rows and its tool-ledger rows. Idempotent: an
    unknown or already purged run is 204 too.

    A run that may still execute (PENDING/ENQUEUED) is refused with 409, since
    it could write rows after the purge: cancel it (POST /runs/{id}/cancel),
    wait until GET /runs/{id} reports a terminal status, then retry.

    Authorization: like every retrieval-server route, this has no app-level
    authentication; only the app's private Flycast address (no public IP)
    keeps it off the internet. The proxy is the authorization point: it calls
    this only from its customer-deletion purge job, with run ids read from its
    own rows, never with an id a client sent."""
    _require_ready()
    st = await _status(run_id)
    if st is not None and st.status in _ACTIVE_STATES:
        raise HTTPException(status_code=409, detail="run is still active: cancel it, then retry")
    try:
        await runs_module.delete_run_data(run_id)
    except Exception as e:
        logger.exception("Failed to purge run %s", run_id)
        raise HTTPException(status_code=500, detail=f"could not delete run data: {e}")
    logger.info("Purged durable run %s", run_id)
    return Response(status_code=204)


@router.get("/runs")
async def list_runs(status: str | None = None, limit: int = 50):
    """List recent durable runs (ops/inspection). Optional ?status= filter
    (SUCCESS / ERROR / PENDING / ENQUEUED / CANCELLED), newest first."""
    _require_ready()
    from dbos import DBOS

    try:
        wfs = await DBOS.list_workflows_async(
            name="agent_run",
            status=[status] if status else None,
            limit=max(1, min(limit, 200)),
            sort_desc=True,
            load_input=False,
            load_output=False,
        )
    except Exception as e:
        logger.exception("list_runs failed")
        raise HTTPException(status_code=500, detail=f"could not list runs: {e}")
    return {"runs": [
        {"run_id": w.workflow_id, "status": w.status, "created_at": w.created_at, "updated_at": w.updated_at,
         # The DBOS application version the run belongs to — what
         # DBOS_APP_VERSION must equal for it to be recovered (development.md).
         "app_version": w.app_version, "recovery_attempts": w.recovery_attempts}
        for w in wfs
    ]}


@router.get("/runs/{run_id}/events")
async def get_run_events(run_id: str, from_seq: int = 0, limit: int = 500):
    """Raw ordered events for a run (debug/inspection)."""
    _require_ready()
    rows = await run_events.read_since(run_id, from_seq, limit=max(1, min(limit, 2000)))
    return {"run_id": run_id, "events": rows}


@router.get("/runs/{run_id}")
async def get_run(run_id: str):
    """Status/result for polling or rediscovery after a page reload."""
    _require_ready()
    st = await _status(run_id)
    if st is None:
        raise HTTPException(status_code=404, detail="run not found")
    out = {
        "run_id": run_id,
        "status": st.status,
        "created_at": st.created_at,
        "updated_at": st.updated_at,
        "last_seq": await run_events.latest_seq(run_id),
    }
    if st.status == "SUCCESS":
        from dbos import DBOS
        try:
            out["result"] = await DBOS.get_result_async(run_id)
        except Exception:
            logger.exception("run %s SUCCESS but result fetch failed", run_id)
    elif st.status in _TERMINAL_STATES:
        out["error"] = st.error
    return out
