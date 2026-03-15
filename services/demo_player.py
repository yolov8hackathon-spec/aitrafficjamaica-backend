"""
services/demo_player.py — Live YOLO inference on the pre-recorded demo video.

Downloads the demo video from Supabase, runs YOLO + ByteTrack frame-by-frame at
real-time speed, and broadcasts detections via the same WebSocket channel as the
live AI.  The live AI task is paused in main.py while this runs.

Broadcast payload matches the live count payload so DetectionOverlay, the count
widget, and the demo sidebar all work with zero frontend changes.
"""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import cv2
import httpx
import numpy as np

logger = logging.getLogger(__name__)

_task: asyncio.Task | None = None
_stop_flag: bool = False
_active: bool = False


def is_active() -> bool:
    return _active


async def start(video_url: str, cfg, manager, camera_id: str) -> dict:
    global _task, _stop_flag, _active
    if _active:
        return {"ok": False, "error": "Demo detection already running"}
    _stop_flag = False
    _active = True
    _task = asyncio.create_task(
        _run(video_url, cfg, manager, camera_id),
        name="demo_detect",
    )
    logger.info("[demo_player] Started demo detection task for camera=%s", camera_id)
    return {"ok": True}


def stop() -> None:
    global _stop_flag, _active
    _stop_flag = True
    _active = False
    if _task and not _task.done():
        _task.cancel()
    logger.info("[demo_player] Stop requested")


async def _run(video_url: str, cfg, manager, camera_id: str) -> None:
    global _active
    tmp_path: str | None = None
    try:
        # ── Download demo video to temp file ─────────────────────────────────
        logger.info("[demo_player] Downloading video: %s", video_url)
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            tmp_path = f.name

        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream("GET", video_url) as r:
                r.raise_for_status()
                with open(tmp_path, "wb") as fh:
                    async for chunk in r.aiter_bytes(65536):
                        if _stop_flag:
                            return
                        fh.write(chunk)

        size_mb = Path(tmp_path).stat().st_size / 1_048_576
        logger.info("[demo_player] Video downloaded: %.1f MB → %s", size_mb, tmp_path)

        # ── Init detector + tracker ───────────────────────────────────────────
        # Import here so the module loads even before YOLO is ready
        from ai.detector import VehicleDetector, CLASS_NAMES
        from ai.tracker import VehicleTracker

        detector = VehicleDetector(
            model_path=cfg.YOLO_MODEL,
            conf_threshold=cfg.YOLO_CONF,
            infer_size=cfg.DETECT_INFER_SIZE,
            iou_threshold=cfg.DETECT_IOU,
            max_det=cfg.DETECT_MAX_DET,
        )
        tracker = VehicleTracker()

        seen_ids: set[int] = set()
        total: int = 0
        vehicle_breakdown: dict[str, int] = {}

        # ── Playback loop (loops video when it ends) ──────────────────────────
        loop_count = 0
        while not _stop_flag:
            loop_count += 1
            cap = cv2.VideoCapture(tmp_path)
            if not cap.isOpened():
                logger.error("[demo_player] Failed to open video: %s", tmp_path)
                break

            fps = float(cap.get(cv2.CAP_PROP_FPS) or 15.0)
            frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            # Process ~6 frames/sec regardless of source FPS for consistent perf
            process_every = max(1, round(fps / 6))
            frame_delay = process_every / fps   # real-time sleep per processed frame

            logger.info(
                "[demo_player] Loop %d: %dx%d @ %.1f fps, processing every %d frames (%.2fs delay)",
                loop_count, frame_w, frame_h, fps, process_every, frame_delay,
            )

            frame_index = 0
            while not _stop_flag:
                ret, frame = cap.read()
                if not ret:
                    break  # end of file → loop

                frame_index += 1
                if frame_index % process_every != 0:
                    continue

                t0 = time.monotonic()

                # Run inference in a thread pool to avoid blocking the event loop
                try:
                    raw_dets = await asyncio.get_running_loop().run_in_executor(
                        None, detector.detect, frame
                    )
                    tracked = await asyncio.get_running_loop().run_in_executor(
                        None, tracker.update, raw_dets, frame
                    )
                except Exception as exc:
                    logger.warning("[demo_player] Inference error: %s", exc)
                    await asyncio.sleep(frame_delay)
                    continue

                # ── Build normalised detection list ───────────────────────────
                dets_out: list[dict] = []
                new_crossings = 0

                if tracked is not None and len(tracked) > 0:
                    for i in range(min(len(tracked.xyxy), 60)):
                        cls_id = int(tracked.class_id[i]) if tracked.class_id is not None else -1
                        cls_name = CLASS_NAMES.get(cls_id, "car")
                        conf = float(tracked.confidence[i]) if tracked.confidence is not None else 0.0
                        if conf < 0.10:
                            continue

                        x1, y1, x2, y2 = tracked.xyxy[i]
                        tid = -1
                        if tracked.tracker_id is not None and i < len(tracked.tracker_id):
                            tid = int(tracked.tracker_id[i])

                        # Count unique tracker IDs as "crossings"
                        if tid >= 0 and tid not in seen_ids:
                            seen_ids.add(tid)
                            total += 1
                            new_crossings += 1
                            vehicle_breakdown[cls_name] = vehicle_breakdown.get(cls_name, 0) + 1

                        dets_out.append({
                            "x1": round(float(x1) / frame_w, 4),
                            "y1": round(float(y1) / frame_h, 4),
                            "x2": round(float(x2) / frame_w, 4),
                            "y2": round(float(y2) / frame_h, 4),
                            "cls": cls_name,
                            "conf": round(conf, 3),
                            "tracker_id": tid,
                            "in_detect_zone": True,
                        })

                # ── Broadcast ─────────────────────────────────────────────────
                if manager.public_count > 0:
                    payload = {
                        "type": "count",
                        "camera_id": camera_id,
                        "captured_at": datetime.now(timezone.utc).isoformat(),
                        "total": total,
                        "count_in": total,
                        "count_out": 0,
                        "new_crossings": new_crossings,
                        "vehicle_breakdown": dict(vehicle_breakdown),
                        "detections": dets_out,
                    }
                    await manager.broadcast_public(payload)

                # ── Throttle to real-time speed ───────────────────────────────
                elapsed = time.monotonic() - t0
                wait = max(0.0, frame_delay - elapsed)
                if wait > 0:
                    await asyncio.sleep(wait)

            cap.release()

            if not _stop_flag:
                logger.info("[demo_player] Video ended — looping (resetting tracker IDs)")
                # Reset tracker state but keep cumulative total so count keeps climbing
                tracker = VehicleTracker()
                seen_ids.clear()
                await asyncio.sleep(0.5)

    except asyncio.CancelledError:
        logger.info("[demo_player] Task cancelled")
    except Exception as exc:
        logger.exception("[demo_player] Unexpected error: %s", exc)
    finally:
        _active = False
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
        logger.info("[demo_player] Stopped")
