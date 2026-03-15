"""
ai/quality.py — Per-camera stream quality metrics.

Computes brightness, sharpness, contrast and a composite quality score
from a single video frame.  Also provides quality_probe_loop which
periodically samples every inactive camera and writes results back to
cameras.quality_snapshot so the admin panel can use them for routing.
"""
import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

import cv2
import numpy as np

logger = logging.getLogger(__name__)

_PROBE_INTERVAL_SEC = 900       # probe every 15 min
_PROBE_STARTUP_DELAY_SEC = 90   # wait for streams to warm up


def compute_quality(frame: np.ndarray) -> dict[str, Any]:
    """
    Return quality metrics for a BGR (or grayscale) frame.

    Keys:
      brightness   float   0-255   mean luminance
      contrast     float   0-127   std-dev of luminance
      sharpness    float   0+      Laplacian variance (higher = sharper)
      lighting     str     "day" | "dusk" | "night"
      quality_score float  0-100   composite (weighted blend)
      captured_at  str     ISO-8601 UTC
    """
    if frame is None or frame.size == 0:
        return {}

    gray = (
        cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if len(frame.shape) == 3
        else frame.copy()
    )

    brightness: float = float(np.mean(gray))
    contrast: float = float(np.std(gray))
    sharpness: float = float(cv2.Laplacian(gray, cv2.CV_64F).var())

    if brightness < 45:
        lighting = "night"
    elif brightness < 88:
        lighting = "dusk"
    else:
        lighting = "day"

    # Score components: penalise dark (<60) and blown-out (>200) equally
    brightness_score = max(0.0, 100.0 - abs(brightness - 130) * 0.75)
    sharpness_score = min(100.0, sharpness / 4.0)   # 400 var → full score
    contrast_score = min(100.0, contrast / 0.55)    # std 55 → full score

    quality_score = (
        brightness_score * 0.35
        + sharpness_score * 0.45
        + contrast_score * 0.20
    )

    return {
        "brightness": round(brightness, 1),
        "contrast": round(contrast, 1),
        "sharpness": round(sharpness, 0),
        "lighting": lighting,
        "quality_score": round(quality_score, 1),
        "captured_at": datetime.now(timezone.utc).isoformat(),
    }


async def _probe_one(alias: str) -> dict[str, Any] | None:
    """Fetch one HLS frame for the given ipcamlive alias and score it."""
    from ai.url_refresher import fetch_fresh_stream_url
    try:
        url = await fetch_fresh_stream_url(alias)
        if not url:
            return None

        def _grab() -> np.ndarray | None:
            cap = cv2.VideoCapture(url)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            ret, frame = cap.read()
            cap.release()
            return frame if ret else None

        frame = await asyncio.to_thread(_grab)
        if frame is None:
            return None
        return compute_quality(frame)
    except Exception as exc:
        logger.debug("Quality probe failed alias=%s: %s", alias, exc)
        return None


async def write_quality_snapshot(camera_id: str, quality: dict) -> None:
    from supabase_client import get_supabase
    try:
        sb = await get_supabase()
        await (
            sb.table("cameras")
            .update({"quality_snapshot": quality})
            .eq("id", camera_id)
            .execute()
        )
    except Exception as exc:
        logger.debug("quality_snapshot write failed camera_id=%s: %s", camera_id, exc)


async def quality_probe_loop(interval_sec: int = _PROBE_INTERVAL_SEC) -> None:
    """
    Probe all cameras that are NOT the active AI cam for quality metrics
    and persist results to cameras.quality_snapshot.
    Active AI cam quality is written directly from the AI loop in real-time.
    """
    from supabase_client import get_supabase

    await asyncio.sleep(_PROBE_STARTUP_DELAY_SEC)

    while True:
        try:
            sb = await get_supabase()
            resp = await (
                sb.table("cameras")
                .select("id, ipcam_alias, is_active")
                .eq("is_active", False)
                .execute()
            )
            cameras = resp.data or []
            for cam in cameras:
                alias = cam.get("ipcam_alias")
                camera_id = cam.get("id")
                if not alias or not camera_id:
                    continue
                quality = await _probe_one(alias)
                if quality:
                    asyncio.create_task(write_quality_snapshot(camera_id, quality))
                    logger.info(
                        "Quality probed alias=%s score=%.1f lighting=%s",
                        alias, quality["quality_score"], quality["lighting"],
                    )
                # Space probes out so we don't hammer ipcamlive
                await asyncio.sleep(8)
        except Exception as exc:
            logger.warning("Quality probe loop error: %s", exc)

        await asyncio.sleep(interval_sec)
