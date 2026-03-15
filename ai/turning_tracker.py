"""
ai/turning_tracker.py — Tracks vehicle turning movements between entry/exit zones.

Loads entry and exit zone definitions from camera_zones table.
For each frame's tracked detections, detects when a vehicle:
  1. Crosses an entry zone line → records (entry_zone, entry_time, class, conf)
                                   and writes a vehicle_crossings row
  2. Later crosses an exit zone → writes a turning_movements row

Hit test uses distance-to-line-segment against the zone's longest edge.
This correctly handles the thin triangular zones saved by the admin zone editor
(where 2 of 3 points are nearly identical = a line segment, not an area).
All zones share the same perpendicular strip width: ZONE_HIT_DIST_RATIO * frame_diagonal.
"""
from __future__ import annotations

import logging
import math
import time
from datetime import datetime, timezone
from typing import Any

import supervision as sv

from ai.detector import CLASS_NAMES
from supabase_client import get_supabase

logger = logging.getLogger(__name__)

ZONE_REFRESH_SEC    = 60     # reload camera_zones every 60 s
TRANSIT_TTL_SEC     = 45     # discard unresolved entry after 45 s
ZONE_HIT_DIST_RATIO = 0.08   # hit strip half-width = 8% of frame diagonal


# ── geometry helpers ──────────────────────────────────────────────────────────

def _longest_edge(
    points: list[dict], frame_w: int, frame_h: int
) -> tuple[float, float, float, float]:
    """
    Return (ax, ay, bx, by) — the longest edge of the zone polygon in pixels.
    For degenerate triangles (two near-identical points), this is the real edge.
    """
    px = [p["x"] * frame_w for p in points]
    py = [p["y"] * frame_h for p in points]
    n = len(px)
    best_d2, best = 0.0, (px[0], py[0], px[1 % n], py[1 % n])
    for i in range(n):
        j = (i + 1) % n
        d2 = (px[j] - px[i]) ** 2 + (py[j] - py[i]) ** 2
        if d2 > best_d2:
            best_d2 = d2
            best = (px[i], py[i], px[j], py[j])
    return best


def _dist_to_segment(
    px: float, py: float,
    ax: float, ay: float,
    bx: float, by: float,
) -> float:
    """Perpendicular distance from point P to line segment A–B."""
    dx, dy = bx - ax, by - ay
    len_sq = dx * dx + dy * dy
    if len_sq < 1.0:
        return math.sqrt((px - ax) ** 2 + (py - ay) ** 2)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / len_sq))
    return math.sqrt((px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2)


class TurningMovementTracker:
    """
    Per-camera turning movement tracker. Initialised once per AI loop session.

    Usage (in main.py):
        tt = TurningMovementTracker(camera_id, frame_w, frame_h)
        ...
        movements, entry_crossings = await tt.process(
            detections, tracker_ids, class_ids, confidences
        )
        if movements:
            asyncio.create_task(write_turning_movements(movements))
        if entry_crossings:
            asyncio.create_task(write_vehicle_crossings(entry_crossings))
    """

    def __init__(self, camera_id: str, frame_width: int, frame_height: int) -> None:
        self.camera_id    = camera_id
        self.frame_width  = frame_width
        self.frame_height = frame_height

        diag = math.sqrt(frame_width ** 2 + frame_height ** 2)
        self._hit_dist = diag * ZONE_HIT_DIST_RATIO   # pixels

        # (name, ax, ay, bx, by) — longest edge of each zone in pixels
        self._entry_zones: list[tuple[str, float, float, float, float]] = []
        self._exit_zones:  list[tuple[str, float, float, float, float]] = []

        # tid → (entry_zone_name, entry_mono, vehicle_class, confidence)
        self._in_entry: dict[int, tuple[str, float, str, float | None]] = {}
        # tids for which we've already written a vehicle_crossings entry row
        self._entry_written: set[int] = set()

        self._last_refresh = 0.0

    # ── zone loading ──────────────────────────────────────────────────────────

    async def _refresh(self) -> None:
        try:
            sb = await get_supabase()
            resp = await (
                sb.table("camera_zones")
                .select("name,zone_type,points")
                .eq("camera_id", self.camera_id)
                .eq("active", True)
                .execute()
            )
        except Exception as exc:
            logger.warning("TurningTracker: zone refresh failed: %s", exc)
            return

        rows = resp.data or []
        entry, exit_ = [], []
        for z in rows:
            pts = z.get("points") or []
            if len(pts) < 2:
                continue
            try:
                ax, ay, bx, by = _longest_edge(pts, self.frame_width, self.frame_height)
            except Exception:
                continue
            rec = (z["name"], ax, ay, bx, by)
            if z["zone_type"] == "entry":
                entry.append(rec)
            elif z["zone_type"] == "exit":
                exit_.append(rec)

        self._entry_zones = entry
        self._exit_zones  = exit_
        self._last_refresh = time.monotonic()
        logger.info(
            "TurningTracker: %d entry zones, %d exit zones, hit_dist=%.0fpx camera=%s",
            len(entry), len(exit_), self._hit_dist, self.camera_id,
        )
        for name, ax, ay, bx, by in entry:
            edge_len = math.sqrt((bx-ax)**2 + (by-ay)**2)
            logger.debug(
                "  entry zone '%s': (%.0f,%.0f)→(%.0f,%.0f) edge=%.0fpx",
                name, ax, ay, bx, by, edge_len,
            )

    # ── frame processing ──────────────────────────────────────────────────────

    async def process(
        self,
        detections: sv.Detections,
        tracker_ids: list[int],
        class_ids: list[int],
        confidences: list[float],
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """
        Check detections against entry/exit zone lines.

        Returns:
            (movements, entry_crossings)
            movements       — completed turning_movements rows (entry→exit)
            entry_crossings — vehicle_crossings rows (zone_source='entry'),
                              one per tracker_id per entry zone visit
        """
        now = time.monotonic()

        # Refresh zones periodically
        if not self._entry_zones or (now - self._last_refresh) > ZONE_REFRESH_SEC:
            await self._refresh()

        if not self._entry_zones or not self._exit_zones:
            return [], []

        if len(detections) == 0 or detections.xyxy is None:
            return [], []

        # Expire stale in-entry records and their written flags
        expired = {
            tid for tid, v in self._in_entry.items() if now - v[1] >= TRANSIT_TTL_SEC
        }
        for tid in expired:
            del self._in_entry[tid]
            self._entry_written.discard(tid)

        completed:       list[dict[str, Any]] = []
        entry_crossings: list[dict[str, Any]] = []

        for i, tid in enumerate(tracker_ids):
            if i >= len(detections.xyxy):
                continue
            x1, y1, x2, y2 = detections.xyxy[i]
            cx = float((x1 + x2) / 2)
            cy = float((y1 + y2) / 2)

            cls_id = int(class_ids[i]) if i < len(class_ids) else -1
            cls    = CLASS_NAMES.get(cls_id, "car")
            conf   = round(float(confidences[i]), 4) if i < len(confidences) else None

            # ── exit check first ─────────────────────────────────────────────
            if tid in self._in_entry:
                entry_name, entry_ts, entry_cls, entry_conf = self._in_entry[tid]
                for (ez_name, ax, ay, bx, by) in self._exit_zones:
                    if _dist_to_segment(cx, cy, ax, ay, bx, by) <= self._hit_dist:
                        dwell_ms = max(0, int((now - entry_ts) * 1000))
                        completed.append({
                            "camera_id":     self.camera_id,
                            "captured_at":   datetime.now(timezone.utc).isoformat(),
                            "track_id":      int(tid),
                            "vehicle_class": entry_cls,
                            "entry_zone":    entry_name,
                            "exit_zone":     ez_name,
                            "dwell_ms":      dwell_ms,
                            "confidence":    entry_conf,
                        })
                        del self._in_entry[tid]
                        self._entry_written.discard(tid)
                        break
                continue   # already in transit — skip entry check

            # ── entry check ──────────────────────────────────────────────────
            for (ez_name, ax, ay, bx, by) in self._entry_zones:
                if _dist_to_segment(cx, cy, ax, ay, bx, by) <= self._hit_dist:
                    self._in_entry[tid] = (ez_name, now, cls, conf)
                    # Write one vehicle_crossings row per entry zone visit
                    if tid not in self._entry_written:
                        self._entry_written.add(tid)
                        entry_crossings.append({
                            "camera_id":     self.camera_id,
                            "captured_at":   datetime.now(timezone.utc).isoformat(),
                            "track_id":      int(tid),
                            "vehicle_class": cls,
                            "confidence":    conf,
                            "direction":     "in",
                            "zone_source":   "entry",
                            "zone_name":     ez_name,
                        })
                    break

        return completed, entry_crossings


# ── DB writers ────────────────────────────────────────────────────────────────

async def write_turning_movements(movements: list[dict]) -> None:
    """Batch-insert completed turning movements into Supabase."""
    if not movements:
        return
    try:
        sb = await get_supabase()
        await sb.table("turning_movements").insert(movements).execute()
        logger.debug("TurningTracker: wrote %d movement(s)", len(movements))
    except Exception as exc:
        logger.warning("write_turning_movements failed (%d rows): %s", len(movements), exc)
