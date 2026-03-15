"""
ws_public.py — /ws/live endpoint.
HMAC token required. Broadcasts live count + market data to all subscribers.
"""
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query, status

from config import get_config
from middleware.hmac_auth import validate_ws_token
from websocket.ws_manager import manager

logger = logging.getLogger(__name__)

router = APIRouter()


@router.websocket("/ws/live")
async def ws_live(
    websocket: WebSocket,
    token: str | None = Query(default=None),
):
    cfg = get_config()

    # Check Origin header
    origin = websocket.headers.get("origin", "")
    if origin and origin != cfg.ALLOWED_ORIGIN:
        logger.warning("WS rejected — bad origin: %s", origin)
        await websocket.close(code=4003)
        return

    # Validate HMAC token
    if not validate_ws_token(token, cfg.WS_AUTH_SECRET):
        logger.warning("WS rejected — invalid HMAC token")
        await websocket.close(code=4001)
        return

    await manager.connect_public(websocket)
    try:
        while True:
            # Keep alive — client doesn't send data, just listens
            data = await websocket.receive_text()
            # Accept ping frames silently
    except WebSocketDisconnect:
        manager.disconnect_public(websocket)
    except Exception as exc:
        logger.warning("Public WS error: %s", exc)
        manager.disconnect_public(websocket)
