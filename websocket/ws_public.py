"""
ws_public.py — /ws/live endpoint.
HMAC token required. Broadcasts live count + market data to all subscribers.
"""
import json
import logging
from urllib.parse import urlsplit

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query, status

from config import get_config
from middleware.hmac_auth import validate_ws_token
from supabase_client import get_supabase
from websocket.ws_manager import manager
from ai.url_refresher import get_current_alias

logger = logging.getLogger(__name__)

router = APIRouter()


def _normalize_origin(value: str) -> str:
    raw = (value or "").strip().rstrip("/")
    if not raw:
        return ""
    parsed = urlsplit(raw)
    if parsed.scheme and parsed.netloc:
        return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"
    return raw.lower()


def _origin_allowed(origin: str, allowed: str) -> bool:
    normalized_origin = _normalize_origin(origin)
    if not normalized_origin:
        return True
    candidates = [p.strip() for p in str(allowed or "").split(",") if p.strip()]
    if not candidates:
        return False
    if any(p == "*" for p in candidates):
        return True
    normalized_allowed = {_normalize_origin(p) for p in candidates}
    return normalized_origin in normalized_allowed


async def _send_bootstrap_count(websocket: WebSocket, camera_alias: str) -> None:
    """
    Send latest persisted count snapshot to a newly connected public client.
    This prevents UI reset after backend restarts/redeploys while first live frame
    is still warming up.
    """
    try:
        sb = await get_supabase()
        cam_resp = await (
            sb.table("cameras")
            .select("id")
            .eq("ipcam_alias", camera_alias)
            .limit(1)
            .execute()
        )
        if cam_resp.data:
            camera_id = cam_resp.data[0]["id"]
        else:
            fallback_resp = await (
                sb.table("cameras")
                .select("id")
                .eq("is_active", True)
                .order("created_at", desc=False)
                .limit(1)
                .execute()
            )
            camera_id = fallback_resp.data[0]["id"] if fallback_resp.data else None
        if not camera_id:
            return

        snap_resp = await (
            sb.table("count_snapshots")
            .select("camera_id,captured_at,count_in,count_out,total,vehicle_breakdown")
            .eq("camera_id", camera_id)
            .order("captured_at", desc=True)
            .limit(1)
            .execute()
        )
        rows = snap_resp.data or []
        if not rows:
            fallback_snap = await (
                sb.table("count_snapshots")
                .select("camera_id,captured_at,count_in,count_out,total,vehicle_breakdown")
                .order("captured_at", desc=True)
                .limit(1)
                .execute()
            )
            rows = fallback_snap.data or []
        if not rows:
            return
        latest = rows[0] or {}
        payload = {
            "type": "count",
            "camera_id": latest.get("camera_id"),
            "captured_at": latest.get("captured_at"),
            "count_in": int(latest.get("count_in", 0) or 0),
            "count_out": int(latest.get("count_out", 0) or 0),
            "total": int(latest.get("total", 0) or 0),
            "vehicle_breakdown": latest.get("vehicle_breakdown") or {},
            "new_crossings": 0,
            "detections": [],
            "bootstrap": True,
        }
        await websocket.send_text(json.dumps(payload))
    except Exception as exc:
        logger.debug("WS bootstrap snapshot skipped: %s", exc)


@router.websocket("/ws/live")
async def ws_live(
    websocket: WebSocket,
    token: str | None = Query(default=None),
):
    cfg = get_config()

    # Check Origin header
    origin = websocket.headers.get("origin", "")
    if not _origin_allowed(origin, cfg.ALLOWED_ORIGIN):
        logger.warning("WS rejected — bad origin: %s", origin)
        await websocket.accept()
        await websocket.close(code=4003)
        return

    # Validate HMAC token
    if not validate_ws_token(token, cfg.WS_AUTH_SECRET):
        logger.warning("WS rejected — invalid HMAC token")
        await websocket.accept()
        await websocket.close(code=4001)
        return

    await manager.connect_public(
        websocket,
        meta={
            "origin": origin,
            "ip": websocket.client.host if websocket.client else None,
            "user_agent": websocket.headers.get("user-agent"),
        },
    )
    await _send_bootstrap_count(websocket, get_current_alias() or cfg.CAMERA_ALIAS)
    _MAX_MSG = 256   # bytes; client only sends keep-alive pings

    try:
        while True:
            data = await websocket.receive_text()
            if len(data.encode()) > _MAX_MSG:
                logger.warning("Public WS oversized message from %s (%d bytes)", origin, len(data.encode()))
                await websocket.close(code=1009, reason="Message too large")
                break
            # Accept ping frames silently
    except WebSocketDisconnect:
        manager.disconnect_public(websocket)
    except Exception as exc:
        logger.warning("Public WS error: %s", exc)
        manager.disconnect_public(websocket)
