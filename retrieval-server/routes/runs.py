"""
Durable agent-run API (see DURABLE_AGENTS_DBOS_PLAN §5.7). Separate from
/retrieve, which stays the stateless fast path.

  POST /runs                 start a durable run  -> {run_id}
  GET  /runs/{id}/stream     subscribe / reattach (SSE, replay-from-seq)
  POST /runs/{id}/resume     deliver client-tool results / human input (P2)
  POST /runs/{id}/cancel     cancel the workflow + drop its event channel
  GET  /runs/{id}            status / result (polling / rediscovery)

The stream tails run_events by polling (the Supabase pooler has no NOTIFY, P0),
so a reconnecting client passes ?from_seq=<last seq it saw> and we replay from
there, then keep tailing. Events are the SAME dict payloads /retrieve emits, so
the proxy's existing SSE→client mapping is unchanged.
"""
import asyncio
import json
import logging
import uuid

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

import durable_runtime
import run_events
import runs as runs_module
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

_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"}


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
        while True:
            if await request.is_disconnected():
                logger.info("Stream %s: client disconnected at seq=%s", run_id, last)
                return
            rows = await run_events.read_since(run_id, last)
            if rows:
                waited = 0.0
                for row in rows:
                    last = row["seq"]
                    yield f"id: {row['seq']}\ndata: {json.dumps(row['event'])}\n\n"
                    if row["terminal"]:
                        yield "data: [DONE]\n\n"
                        return
                continue
            # No new events: stop if the workflow is finished (covers a crash
            # that never wrote a terminal row) or if we've tailed too long.
            st = await _status(run_id)
            if st is not None and st.status in _TERMINAL_STATES:
                # One last drain in case events landed between read and status.
                for row in await run_events.read_since(run_id, last):
                    last = row["seq"]
                    yield f"id: {row['seq']}\ndata: {json.dumps(row['event'])}\n\n"
                yield "data: [DONE]\n\n"
                return
            waited += _POLL_INTERVAL_SEC
            if waited >= _STREAM_MAX_SEC:
                logger.warning("Stream %s: max duration reached, closing", run_id)
                yield "data: [DONE]\n\n"
                return
            await asyncio.sleep(_POLL_INTERVAL_SEC)

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
        DBOS.cancel_workflow(run_id)
    except Exception as e:
        logger.exception("Failed to cancel run %s", run_id)
        raise HTTPException(status_code=500, detail=f"could not cancel run: {e}")
    await run_events.delete_run(run_id)
    logger.info("Cancelled durable run %s", run_id)
    return {"run_id": run_id, "status": "cancelled"}


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
