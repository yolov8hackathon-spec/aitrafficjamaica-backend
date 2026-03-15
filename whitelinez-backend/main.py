"""
main.py — FastAPI application entry point.
- Validates env at startup (fail-fast)
- Starts AI background task
- Mounts all routers and WebSocket endpoints
"""
import asyncio
import json
import logging
import sys
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from config import get_config
from middleware.rate_limiter import limiter
from routers import bets, rounds, admin
from websocket.ws_public import router as ws_public_router
from websocket.ws_account import router as ws_account_router
from websocket.ws_manager import manager
from supabase_client import get_supabase, close_supabase
from ai.stream import HLSStream
from ai.detector import VehicleDetector
from ai.tracker import VehicleTracker
from ai.counter import LineCounter, write_snapshot

# ── Logging setup ──────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)

# ── AI background task ─────────────────────────────────────────────────────────

_ai_task: asyncio.Task | None = None


async def ai_loop(cfg) -> None:
    """
    Continuous AI pipeline:
    HLS frames → YOLO detect → ByteTrack → LineZone → Supabase snapshot + WS broadcast
    """
    stream = HLSStream(cfg.HLS_STREAM_URL)
    detector = VehicleDetector(model_path=cfg.YOLO_MODEL, conf_threshold=cfg.YOLO_CONF)
    tracker = VehicleTracker()

    # Resolve camera_id (first active camera)
    sb = await get_supabase()
    cam_resp = await sb.table("cameras").select("id").eq("is_active", True).limit(1).execute()
    camera_id = cam_resp.data[0]["id"] if cam_resp.data else "default"
    logger.info("AI loop using camera_id: %s", camera_id)

    frame_buf = None
    counter: LineCounter | None = None

    async for frame in stream.frames():
        if frame_buf is None:
            h, w = frame.shape[:2]
            counter = LineCounter(camera_id, w, h)
            frame_buf = True
            logger.info("AI loop started: frame size %dx%d", w, h)

        detections = detector.detect(frame)
        tracked = tracker.update(detections)
        snapshot = await counter.process(frame, tracked)

        # Write to Supabase (non-blocking)
        asyncio.create_task(write_snapshot(snapshot))

        # Broadcast to all public WS subscribers
        if manager.public_count > 0:
            await manager.broadcast_public({
                "type": "count",
                **snapshot,
            })


# ── Lifespan ───────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _ai_task

    # Fail-fast config validation
    cfg = get_config()
    logger.info("Config validated — starting WHITELINEZ backend")

    # Init Supabase client
    await get_supabase()

    # Start AI background task
    _ai_task = asyncio.create_task(ai_loop(cfg), name="ai_loop")
    logger.info("AI loop task started")

    yield

    # Shutdown
    if _ai_task and not _ai_task.done():
        _ai_task.cancel()
        try:
            await _ai_task
        except asyncio.CancelledError:
            pass

    await close_supabase()
    logger.info("WHITELINEZ backend shutdown complete")


# ── App ────────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="WHITELINEZ API",
    version="1.0.0",
    docs_url="/docs",
    redoc_url=None,
    lifespan=lifespan,
)

# Rate limiter
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS — only allow Vercel frontend
cfg_once = None
try:
    cfg_once = get_config()
    allowed_origins = [cfg_once.ALLOWED_ORIGIN]
except Exception:
    allowed_origins = []

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

# ── Routers ────────────────────────────────────────────────────────────────────
app.include_router(bets.router)
app.include_router(rounds.router)
app.include_router(admin.router)
app.include_router(ws_public_router)
app.include_router(ws_account_router)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "public_ws_connections": manager.public_count,
        "user_ws_connections": manager.user_count,
        "ai_task_running": _ai_task is not None and not _ai_task.done(),
    }


@app.exception_handler(Exception)
async def generic_error_handler(request: Request, exc: Exception):
    logger.error("Unhandled error on %s: %s", request.url, exc, exc_info=True)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})
