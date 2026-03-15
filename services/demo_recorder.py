"""
services/demo_recorder.py — One-shot stream recorder for demo footage.

Records live HLS stream via ffmpeg AND captures all WebSocket broadcast
payloads in-process (via capture_event hook called from main.py).

Uploads three files to Supabase Storage 'demo-videos' bucket:
  demo_<ts>.mp4       — H.264 video, ~200-400 MB for 10 min
  events_<ts>.json    — [{t, type, total, detections, ...}] replay data
  manifest.json       — {available, video_url, events_url, ...} (overwritten each run)

Frontend reads manifest.json, plays the video, and dispatches stored
count:update events synced to video.currentTime for frame-accurate overlay replay.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path

import httpx

from ai.url_refresher import get_current_url, fetch_fresh_stream_url, get_current_alias

logger = logging.getLogger(__name__)

_BUCKET = "demo-videos"

# ── Module-level state ────────────────────────────────────────────────────────
_task: asyncio.Task | None = None
_status: dict = {"state": "idle", "progress": 0, "url": None, "error": None, "started_at": None}

# Event capture — set True while recording, filled by capture_event() hook
_capture_active: bool = False
_capture_buffer: list[dict] = []
_capture_start: float = 0.0


def get_status() -> dict:
    return dict(_status)


def capture_event(payload: dict) -> None:
    """
    Hook called from main.py on every broadcast_public() call.
    Records the payload with a video-relative timestamp.
    Only runs when _capture_active is True.
    """
    if not _capture_active:
        return
    t = round(time.time() - _capture_start, 3)
    # Store minimal fields needed for frontend replay
    entry: dict = {
        "t": t,
        "type": payload.get("type", "count"),
        "total": payload.get("total", 0),
        "count_in": payload.get("count_in", 0),
        "count_out": payload.get("count_out", 0),
        "new_crossings": payload.get("new_crossings", 0),
        "vehicle_breakdown": payload.get("vehicle_breakdown") or {},
        "detections": payload.get("detections") or [],
        "camera_id": payload.get("camera_id"),
    }
    _capture_buffer.append(entry)


async def start_recording(duration_sec: int, cfg) -> dict:
    """Kick off a background recording task. Returns immediately."""
    global _task
    if _status["state"] == "recording":
        return {"ok": False, "error": "Already recording", "status": _status}
    _task = asyncio.create_task(_record(duration_sec, cfg))
    return {"ok": True, "message": f"Recording started for {duration_sec}s"}


# ── Internal ──────────────────────────────────────────────────────────────────

async def _record(duration_sec: int, cfg) -> None:
    global _status, _capture_active, _capture_buffer, _capture_start
    _status = {"state": "recording", "progress": 0, "url": None, "error": None, "started_at": time.time()}

    out_path = f"/tmp/demo_{int(time.time())}.mp4"
    ts = int(time.time())
    try:
        # ── 1. Get stream URL ─────────────────────────────────────────────────
        stream_url = get_current_url()
        if not stream_url:
            alias = get_current_alias()
            if alias:
                stream_url = await fetch_fresh_stream_url(alias)
        if not stream_url:
            _status.update({"state": "error", "error": "No stream URL available"})
            return

        logger.info("[demo_recorder] Recording %ds → %s", duration_sec, out_path)

        # ── 2. Start event capture ────────────────────────────────────────────
        _capture_buffer = []
        _capture_start = time.time()
        _capture_active = True

        # ── 3. ffmpeg capture ─────────────────────────────────────────────────
        cmd = [
            "ffmpeg", "-y",
            "-i", stream_url,
            "-t", str(duration_sec),
            "-c:v", "libx264",
            "-preset", "fast",
            "-crf", "26",
            "-vf", "scale='min(1280,iw)':-2",
            "-an",
            "-movflags", "+faststart",
            out_path,
        ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        async def _watch():
            elapsed = 0
            while proc.returncode is None:
                await asyncio.sleep(10)
                elapsed += 10
                _status["progress"] = min(88, int(elapsed / duration_sec * 88))

        watcher = asyncio.create_task(_watch())
        _, stderr_bytes = await proc.communicate()
        watcher.cancel()

        # Stop capturing as soon as ffmpeg finishes
        _capture_active = False
        events_snapshot = list(_capture_buffer)

        if proc.returncode != 0:
            err = stderr_bytes.decode(errors="replace")[-400:]
            logger.error("[demo_recorder] ffmpeg failed: %s", err)
            _status.update({"state": "error", "error": f"ffmpeg exit {proc.returncode}: {err}"})
            return

        file_size = Path(out_path).stat().st_size
        logger.info("[demo_recorder] Recorded %d bytes, %d events. Uploading…", file_size, len(events_snapshot))
        _status["progress"] = 90

        # ── 4. Serialize events JSON ──────────────────────────────────────────
        events_path = f"/tmp/events_{ts}.json"
        with open(events_path, "w") as fh:
            json.dump(events_snapshot, fh, separators=(",", ":"))

        # ── 5. Upload to Supabase storage ─────────────────────────────────────
        supabase = cfg.SUPABASE_URL.rstrip("/")
        svc_key  = cfg.SUPABASE_SERVICE_ROLE_KEY
        headers  = {"Authorization": f"Bearer {svc_key}", "x-upsert": "true"}

        video_remote  = f"demo_{ts}.mp4"
        events_remote = f"events_{ts}.json"

        async with httpx.AsyncClient(timeout=300) as client:
            # Upload video
            _status["progress"] = 91
            with open(out_path, "rb") as fh:
                r = await client.post(
                    f"{supabase}/storage/v1/object/{_BUCKET}/{video_remote}",
                    content=fh.read(),
                    headers={**headers, "Content-Type": "video/mp4"},
                )
            if r.status_code not in (200, 201):
                _status.update({"state": "error", "error": f"Video upload {r.status_code}: {r.text[:200]}"})
                return
            _status["progress"] = 96

            # Upload events JSON
            with open(events_path, "rb") as fh:
                r = await client.post(
                    f"{supabase}/storage/v1/object/{_BUCKET}/{events_remote}",
                    content=fh.read(),
                    headers={**headers, "Content-Type": "application/json"},
                )
            if r.status_code not in (200, 201):
                _status.update({"state": "error", "error": f"Events upload {r.status_code}: {r.text[:200]}"})
                return
            _status["progress"] = 98

            # Upload / overwrite manifest.json
            pub_base = f"{supabase}/storage/v1/object/public/{_BUCKET}"
            manifest = {
                "available": True,
                "video_url": f"{pub_base}/{video_remote}",
                "events_url": f"{pub_base}/{events_remote}",
                "duration_sec": duration_sec,
                "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts)),
                "event_count": len(events_snapshot),
            }
            r = await client.post(
                f"{supabase}/storage/v1/object/{_BUCKET}/manifest.json",
                content=json.dumps(manifest).encode(),
                headers={**headers, "Content-Type": "application/json"},
            )
            if r.status_code not in (200, 201):
                _status.update({"state": "error", "error": f"Manifest upload {r.status_code}: {r.text[:200]}"})
                return

        logger.info("[demo_recorder] Done. Video: %s | Events: %d", manifest["video_url"], len(events_snapshot))
        _status.update({"state": "done", "progress": 100, "url": manifest["video_url"], "error": None})

    except Exception as exc:
        _capture_active = False
        logger.exception("[demo_recorder] Unexpected error")
        _status.update({"state": "error", "error": str(exc)})
    finally:
        _capture_active = False
        for p in (out_path, f"/tmp/events_{ts}.json"):
            try:
                os.unlink(p)
            except FileNotFoundError:
                pass
