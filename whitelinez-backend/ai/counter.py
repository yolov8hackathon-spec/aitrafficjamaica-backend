"""
ai/counter.py — LineZone crossing counter + Supabase snapshot writer.
Polls the cameras table for the admin-defined count line every 30s.
Writes count_snapshots to Supabase every frame.
"""
import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any

import numpy as np
import supervision as sv

from ai.detector import CLASS_NAMES
from supabase_client import get_supabase
from config import get_config

logger = logging.getLogger(__name__)

LINE_REFRESH_INTERVAL = 30  # seconds


class LineCounter:
    """
    Manages a sv.LineZone that counts vehicles crossing a user-defined line.
    Hot-reloads the line from Supabase every LINE_REFRESH_INTERVAL seconds.
    """

    def __init__(self, camera_id: str, frame_width: int, frame_height: int):
        self.camera_id = camera_id
        self.frame_width = frame_width
        self.frame_height = frame_height
        self._line_zone: sv.LineZone | None = None
        self._last_refresh = 0.0
        self._counts: dict[str, dict] = {}  # {class_name: {in, out}}

    async def _refresh_line(self) -> None:
        """Fetch count_line from Supabase cameras table."""
        cfg = get_config()
        sb = await get_supabase()
        resp = await sb.table("cameras").select("count_line").eq("id", self.camera_id).single().execute()
        line_data = resp.data.get("count_line") if resp.data else None

        if line_data:
            # Relative coords → pixel coords
            x1 = int(line_data["x1"] * self.frame_width)
            y1 = int(line_data["y1"] * self.frame_height)
            x2 = int(line_data["x2"] * self.frame_width)
            y2 = int(line_data["y2"] * self.frame_height)
        else:
            # Fallback: horizontal line at COUNT_LINE_RATIO
            ratio = cfg.COUNT_LINE_RATIO
            y = int(ratio * self.frame_height)
            x1, y1, x2, y2 = 0, y, self.frame_width, y
            logger.debug("No DB count line — using fallback ratio %.2f", ratio)

        start = sv.Point(x1, y1)
        end = sv.Point(x2, y2)
        self._line_zone = sv.LineZone(start=start, end=end)
        self._last_refresh = time.monotonic()
        logger.debug("LineZone set: (%d,%d)→(%d,%d)", x1, y1, x2, y2)

    async def process(
        self, frame: np.ndarray, detections: sv.Detections
    ) -> dict[str, Any]:
        """
        Update LineZone with tracked detections.
        Returns snapshot dict suitable for DB insert + WS broadcast.
        """
        now = time.monotonic()
        if self._line_zone is None or (now - self._last_refresh) > LINE_REFRESH_INTERVAL:
            await self._refresh_line()

        # Trigger crossing logic
        crossed_in, crossed_out = self._line_zone.trigger(detections=detections)

        # Accumulate per-class counts
        for i, (in_flag, out_flag) in enumerate(zip(crossed_in, crossed_out)):
            if i >= len(detections.class_id):
                continue
            cls_name = CLASS_NAMES.get(int(detections.class_id[i]), "unknown")
            bucket = self._counts.setdefault(cls_name, {"in": 0, "out": 0})
            if in_flag:
                bucket["in"] += 1
            if out_flag:
                bucket["out"] += 1

        total_in = self._line_zone.in_count
        total_out = self._line_zone.out_count
        total = total_in + total_out
        breakdown = {cls: v["in"] + v["out"] for cls, v in self._counts.items()}

        snapshot = {
            "camera_id": self.camera_id,
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "count_in": total_in,
            "count_out": total_out,
            "total": total,
            "vehicle_breakdown": breakdown,
        }
        return snapshot

    def reset(self) -> None:
        """Reset counters (called at round start)."""
        self._counts.clear()
        if self._line_zone:
            self._line_zone.in_count = 0
            self._line_zone.out_count = 0


async def write_snapshot(snapshot: dict[str, Any]) -> None:
    """Write a count snapshot to Supabase (non-blocking, fire-and-forget)."""
    try:
        sb = await get_supabase()
        await sb.table("count_snapshots").insert(snapshot).execute()
    except Exception as exc:
        logger.warning("Snapshot write failed: %s", exc)
