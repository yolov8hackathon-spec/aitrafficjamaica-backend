"""
services/ml_capture_monitor.py - Lightweight in-memory log buffer for live ML capture.
"""
from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
from threading import Lock
from typing import Any

_MAX_EVENTS = 300
_events: deque[dict[str, Any]] = deque(maxlen=_MAX_EVENTS)
_lock = Lock()
_capture_total = 0
_upload_success_total = 0
_upload_fail_total = 0
_capture_paused = False


def record_capture_event(event: str, message: str, meta: dict[str, Any] | None = None) -> None:
    global _capture_total, _upload_success_total, _upload_fail_total
    now_iso = datetime.now(timezone.utc).isoformat()
    payload = {
        "ts": now_iso,
        "event": str(event),
        "message": str(message),
        "meta": meta or {},
    }
    with _lock:
        _events.append(payload)
        if event == "capture_saved":
            _capture_total += 1
        elif event == "upload_success":
            _upload_success_total += 1
        elif event == "upload_failed":
            _upload_fail_total += 1


def get_capture_status(limit: int = 50) -> dict[str, Any]:
    safe_limit = max(1, min(int(limit), 200))
    with _lock:
        events = list(_events)[-safe_limit:]
        return {
            "capture_total": _capture_total,
            "upload_success_total": _upload_success_total,
            "upload_fail_total": _upload_fail_total,
            "capture_paused": bool(_capture_paused),
            "events": events,
        }


def set_capture_paused(paused: bool) -> bool:
    global _capture_paused
    with _lock:
        _capture_paused = bool(paused)
        return _capture_paused


def is_capture_paused() -> bool:
    with _lock:
        return bool(_capture_paused)
