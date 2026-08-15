import logging

from fastapi import APIRouter, WebSocket

from voice.session import handle_voice_session

logger = logging.getLogger(__name__)

router = APIRouter()


@router.websocket("/voice")
async def voice_websocket(websocket: WebSocket):
    await handle_voice_session(websocket)
