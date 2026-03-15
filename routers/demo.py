"""
routers/demo.py — Demo overlay endpoints.

GET  /demo/manifest   — returns latest recording manifest (public, no auth)
POST /demo/start-detect — start live YOLO inference on the demo video
POST /demo/stop-detect  — stop demo YOLO inference, resume live AI
Both POST endpoints require X-Demo-Secret header matching DEMO_SECRET env var.
"""
import logging

import httpx
from fastapi import APIRouter, HTTPException, Request

from config import get_config

router = APIRouter(prefix="/demo", tags=["demo"])
logger = logging.getLogger(__name__)


def _check_secret(request: Request) -> None:
    cfg = get_config()
    secret = cfg.DEMO_SECRET
    if not secret:
        raise HTTPException(status_code=503, detail="Demo detection not configured")
    provided = request.headers.get("x-demo-secret", "")
    if provided != secret:
        raise HTTPException(status_code=401, detail="Unauthorized")


@router.get("/manifest")
async def demo_manifest():
    cfg = get_config()
    url = f"{cfg.SUPABASE_URL.rstrip('/')}/storage/v1/object/public/demo-videos/manifest.json"
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get(url)
        if r.status_code == 200:
            return r.json()
    except Exception as exc:
        logger.debug("[demo] manifest fetch error: %s", exc)
    return {"available": False}


@router.post("/start-detect")
async def demo_start_detect(request: Request):
    _check_secret(request)
    from services import demo_player

    if demo_player.is_active():
        return {"ok": True, "message": "Already running"}

    # Fetch manifest to get video URL
    cfg = get_config()
    manifest_url = f"{cfg.SUPABASE_URL.rstrip('/')}/storage/v1/object/public/demo-videos/manifest.json"
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get(manifest_url)
        if r.status_code != 200:
            raise HTTPException(status_code=503, detail="Demo manifest unavailable")
        manifest = r.json()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Manifest fetch failed: {exc}") from exc

    if not manifest.get("available") or not manifest.get("video_url"):
        raise HTTPException(status_code=404, detail="No demo recording available")

    # Pause live AI and start demo detector
    app = request.app
    await _pause_live_ai(app)

    manager = app.state.ws_manager
    camera_id = getattr(app.state, "demo_camera_id", None) or "demo"

    result = await demo_player.start(
        video_url=manifest["video_url"],
        cfg=cfg,
        manager=manager,
        camera_id=camera_id,
    )

    # Notify all WebSocket clients that live AI is now offline (demo mode)
    try:
        await manager.broadcast_public({
            "type": "demo_mode",
            "active": True,
            "message": "AI inference running on demo recording",
        })
    except Exception as exc:
        logger.warning("[demo_router] demo_mode broadcast failed: %s", exc)

    return result


@router.post("/stop-detect")
async def demo_stop_detect(request: Request):
    _check_secret(request)
    from services import demo_player

    demo_player.stop()

    app = request.app
    manager = app.state.ws_manager

    # Notify clients that live AI is resuming before we restart it
    try:
        await manager.broadcast_public({
            "type": "demo_mode",
            "active": False,
            "message": "AI inference returning to live stream",
        })
    except Exception as exc:
        logger.warning("[demo_router] demo_mode broadcast failed: %s", exc)

    # Resume live AI
    await _resume_live_ai(app)

    return {"ok": True}


async def _pause_live_ai(app) -> None:
    """Cancel the live AI task so demo YOLO has the floor."""
    import main as _main  # avoid circular at module level
    task = getattr(_main, "_ai_task", None)
    if task and not task.done():
        task.cancel()
        try:
            await task
        except BaseException:
            pass
    _main._demo_mode = True
    logger.info("[demo_router] Live AI paused for demo detection")


async def _resume_live_ai(app) -> None:
    """Re-start live AI after demo ends."""
    import main as _main
    _main._demo_mode = False
    cfg = get_config()
    try:
        await _main._ensure_ai_task(cfg, timeout_sec=6, reason="demo_end")
    except Exception as exc:
        logger.warning("[demo_router] Failed to restart live AI: %s", exc)
    logger.info("[demo_router] Live AI resumed after demo detection")
