"""
ai/box_smoother.py - EMA smoothing for bounding box coordinates.

Applied to visual/WebSocket output ONLY.
Raw tracker state and counting logic are never modified.
"""
import time
from typing import Any


class BoxSmoother:
    """
    Per-track-ID EMA smoothing for normalized box coordinates (x1, y1, x2, y2).

    alpha: weight on the PREVIOUS smoothed value.
           0.70 → 70% old, 30% new per frame. Higher = smoother but more lag.
    max_jump_ratio: if a box moves more than this fraction of its own size
                    per frame, dampen the update (clamp unrealistic snaps).
    ttl_sec: evict stale tracks after this many seconds without updates.
    """

    def __init__(
        self,
        alpha: float = 0.70,
        max_jump_ratio: float = 0.20,
        ttl_sec: float = 3.0,
    ):
        self.alpha = max(0.0, min(0.99, float(alpha)))
        self.max_jump_ratio = max(0.01, float(max_jump_ratio))
        self.ttl_sec = max(0.5, float(ttl_sec))
        self._boxes: dict[int, list[float]] = {}   # tid -> [x1, y1, x2, y2]
        self._last_seen: dict[int, float] = {}      # tid -> monotonic timestamp

    def smooth_detections(
        self,
        detections: list[dict[str, Any]],
        fps: float = 15.0,
    ) -> list[dict[str, Any]]:
        """
        Apply EMA smoothing to a list of detection dicts.
        Each dict must have x1, y1, x2, y2 keys.
        tracker_id is optional — untracked boxes pass through unmodified.
        Returns a new list with smoothed coordinates; all other fields unchanged.
        """
        if not detections:
            return detections

        now = time.monotonic()
        smoothed_out: list[dict[str, Any]] = []

        for det in detections:
            tid = det.get("tracker_id")
            if tid is None or not isinstance(tid, int) or tid < 0:
                smoothed_out.append(det)
                continue

            x1 = float(det.get("x1", 0.0))
            y1 = float(det.get("y1", 0.0))
            x2 = float(det.get("x2", 1.0))
            y2 = float(det.get("y2", 1.0))

            if tid not in self._boxes:
                # First time we see this track — no smoothing yet.
                self._boxes[tid] = [x1, y1, x2, y2]
                self._last_seen[tid] = now
                smoothed_out.append(det)
                continue

            prev = self._boxes[tid]

            # Jump clamp: if box moves more than max_jump_ratio of its size
            # per frame (scaled by fps), dampen more aggressively.
            box_w = max(1e-4, prev[2] - prev[0])
            box_h = max(1e-4, prev[3] - prev[1])
            fps_factor = max(1.0, fps / 15.0)
            max_jump = self.max_jump_ratio * max(box_w, box_h) / fps_factor
            jump = max(abs(x1 - prev[0]), abs(y1 - prev[1]))

            if jump > max_jump:
                eff_alpha = min(0.95, self.alpha + 0.18)
            else:
                eff_alpha = self.alpha

            sx1 = eff_alpha * prev[0] + (1.0 - eff_alpha) * x1
            sy1 = eff_alpha * prev[1] + (1.0 - eff_alpha) * y1
            sx2 = eff_alpha * prev[2] + (1.0 - eff_alpha) * x2
            sy2 = eff_alpha * prev[3] + (1.0 - eff_alpha) * y2

            self._boxes[tid] = [sx1, sy1, sx2, sy2]
            self._last_seen[tid] = now

            smoothed_out.append({
                **det,
                "x1": round(sx1, 4),
                "y1": round(sy1, 4),
                "x2": round(sx2, 4),
                "y2": round(sy2, 4),
            })

        self._cleanup(now)
        return smoothed_out

    def _cleanup(self, now: float) -> None:
        stale = [
            tid for tid, ts in self._last_seen.items()
            if (now - ts) > self.ttl_sec
        ]
        for tid in stale:
            self._boxes.pop(tid, None)
            self._last_seen.pop(tid, None)

    def reset(self) -> None:
        """Clear all smoothing state (call on camera switch or stream restart)."""
        self._boxes.clear()
        self._last_seen.clear()
