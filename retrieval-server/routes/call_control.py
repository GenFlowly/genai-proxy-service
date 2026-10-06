"""REST surface for the WebRTC call-control channel (see voice/call_control.py).

Called by genai-proxy-server, which resolves the customer's vendor key and
identity; this layer owns the actual vendor WebSocket.
"""
import logging

from fastapi import APIRouter
from pydantic import BaseModel

from voice import call_control

logger = logging.getLogger(__name__)

router = APIRouter()


class AttachCallRequest(BaseModel):
    api_key: str
    call_id: str
    customer_id: str
    # Optional initial session.update payload (e.g. tool declarations).
    session_update: dict | None = None
    # Where to POST the model's function calls; response {"output": str}.
    webhook_url: str | None = None
    webhook_secret: str | None = None


class SendCallEventsRequest(BaseModel):
    call_id: str
    customer_id: str
    events: list[dict]


class CallRef(BaseModel):
    call_id: str
    customer_id: str


@router.post("/voice/calls/attach")
async def attach_call(req: AttachCallRequest) -> dict:
    try:
        control = await call_control.attach(
            call_id=req.call_id,
            api_key=req.api_key,
            customer_id=req.customer_id,
            session_update=req.session_update,
            webhook_url=req.webhook_url,
            webhook_secret=req.webhook_secret,
        )
        return {"attached": True, **control.summary()}
    except PermissionError as e:
        return {"attached": False, "error": str(e)}
    except Exception as e:
        logger.warning("Attach failed for call %s: %s", req.call_id, e)
        return {"attached": False, "error": f"Could not attach to call: {e}"}


@router.post("/voice/calls/events")
async def send_call_events(req: SendCallEventsRequest) -> dict:
    control = call_control.get_control(req.call_id, req.customer_id)
    if control is None or control.closed:
        return {"sent": 0, "error": "No live control channel for this call"}
    try:
        sent = await call_control.send_events(control, req.events)
        return {"sent": sent}
    except ValueError as e:
        return {"sent": 0, "error": str(e)}
    except Exception as e:
        logger.warning("Event send failed for call %s: %s", req.call_id, e)
        return {"sent": 0, "error": f"Send failed: {e}"}


@router.post("/voice/calls/status")
async def call_status(req: CallRef) -> dict:
    control = call_control.get_control(req.call_id, req.customer_id)
    if control is None:
        return {"attached": False, "error": "Unknown call"}
    return control.summary()


@router.post("/voice/calls/detach")
async def detach_call(req: CallRef) -> dict:
    control = call_control.get_control(req.call_id, req.customer_id)
    if control is None:
        return {"attached": False, "error": "Unknown call"}
    summary = await call_control.detach(control)
    return summary
