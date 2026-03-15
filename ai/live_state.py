"""
ai/live_state.py — Lightweight shared state so bet_service can read the live
counter snapshot at bet placement time without importing from main.py.

No logic lives here — it's just a thread-safe write-once-read-many slot.
main.py writes after each processed frame; bet_service.py reads at placement.
"""
from typing import Any

_live_snapshot: dict[str, Any] | None = None


def set_live_snapshot(snapshot: dict[str, Any] | None) -> None:
    """Called by the AI loop after each frame is processed."""
    global _live_snapshot
    _live_snapshot = snapshot


def get_live_snapshot() -> dict[str, Any] | None:
    """Returns the most recent count snapshot, or None if not yet available."""
    return _live_snapshot
