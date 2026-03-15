"""
ws_account.py — /ws/account endpoint.
Supabase JWT required. Pushes per-user balance updates and resolved bet events.
"""
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

from config import get_config
from services.auth_service import validate_supabase_jwt, get_user_id
from services.bet_service import get_user_balance
from websocket.ws_manager import manager

logger = logging.getLogger(__name__)

router = APIRouter()


@router.websocket("/ws/account")
async def ws_account(
    websocket: WebSocket,
    token: str | None = Query(default=None),
):
    cfg = get_config()

    # Check Origin
    origin = websocket.headers.get("origin", "")
    if origin and origin != cfg.ALLOWED_ORIGIN:
        await websocket.close(code=4003)
        return

    # Validate Supabase JWT
    if not token:
        await websocket.close(code=4001)
        return
    try:
        payload = await validate_supabase_jwt(token)
        user_id = get_user_id(payload)
    except Exception:
        await websocket.close(code=4001)
        return

    await manager.connect_user(websocket, user_id)

    # Send initial balance on connect
    try:
        balance = await get_user_balance(user_id)
        await websocket.send_json({"type": "balance", "balance": balance})
    except Exception as exc:
        logger.warning("Failed to send initial balance to user %s: %s", user_id, exc)

    try:
        while True:
            _ = await websocket.receive_text()  # keep alive
    except WebSocketDisconnect:
        manager.disconnect_user(websocket, user_id)
    except Exception as exc:
        logger.warning("Account WS error for user %s: %s", user_id, exc)
        manager.disconnect_user(websocket, user_id)
