"""
ai/occlusion_guard.py — Rolling-window camera occlusion detection.

Watches quality metrics from compute_quality() and fires an alert when
the camera appears blocked, fogged, or physically misaligned.

Criteria (configurable):
  - sharpness drops below _SHARP_THRESH for _CONSEC_FRAMES consecutive frames
    (e.g. lens obscured, heavy condensation, camera spun away)
  - brightness drops below _BRIGHT_THRESH (lens fully blocked / covered)
  - quality_score below _SCORE_THRESH for extended period (general degradation)

Usage (AI loop):
    guard = OcclusionGuard()
    alert = guard.check(quality_dict)
    if alert:
        await manager.broadcast_public({"type": "camera_alert", **alert})
"""
import logging
from collections import deque
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

_SHARP_THRESH   = 18.0   # Laplacian variance — anything below this is blurry/blocked
_BRIGHT_THRESH  = 6.0    # Mean luminance — nearly black = lens covered
_SCORE_THRESH   = 8.0    # Composite quality score — extreme degradation
_CONSEC_FRAMES  = 6      # Consecutive bad frames before alert fires
_WINDOW         = 20     # Rolling window size for trend analysis
_ALERT_COOLDOWN = 300    # Seconds between repeated alerts for the same reason


class OcclusionGuard:
    """
    Feed quality dicts from compute_quality() into check().
    Returns an alert payload dict when an occlusion condition is detected,
    None otherwise.
    """

    def __init__(self) -> None:
        self._sharpness_window: deque[float] = deque(maxlen=_WINDOW)
        self._score_window:     deque[float] = deque(maxlen=_WINDOW)
        self._consec_bad: int = 0
        self._last_alert_at: dict[str, float] = {}   # reason → monotonic time

    def _cooldown_ok(self, reason: str) -> bool:
        import time
        last = self._last_alert_at.get(reason, 0.0)
        return (time.monotonic() - last) >= _ALERT_COOLDOWN

    def _record_alert(self, reason: str) -> None:
        import time
        self._last_alert_at[reason] = time.monotonic()

    def check(self, quality: dict[str, Any]) -> dict[str, Any] | None:
        """
        Returns an alert dict if an occlusion condition is detected, else None.
        Call this every time quality metrics are computed from the AI loop.
        """
        if not quality:
            return None

        sharpness = float(quality.get("sharpness") or 0.0)
        brightness = float(quality.get("brightness") or 0.0)
        score = float(quality.get("quality_score") or 0.0)

        self._sharpness_window.append(sharpness)
        self._score_window.append(score)

        # ── Immediate: full lens block (near-black frame) ─────────
        if brightness < _BRIGHT_THRESH:
            reason = "lens_blocked"
            if self._cooldown_ok(reason):
                self._record_alert(reason)
                logger.warning("OcclusionGuard: lens appears fully blocked (brightness=%.1f)", brightness)
                return self._build_alert(reason, "Lens appears fully blocked", quality, severity="critical")

        # ── Sustained: consecutive low-sharpness frames ───────────
        if sharpness < _SHARP_THRESH:
            self._consec_bad += 1
        else:
            self._consec_bad = 0

        if self._consec_bad >= _CONSEC_FRAMES:
            reason = "low_sharpness"
            if self._cooldown_ok(reason):
                self._record_alert(reason)
                logger.warning(
                    "OcclusionGuard: %d consecutive low-sharpness frames (sharpness=%.1f)",
                    self._consec_bad, sharpness,
                )
                return self._build_alert(
                    reason,
                    f"Camera feed degraded — {self._consec_bad} blurry frames",
                    quality,
                    severity="warning",
                )

        # ── Trend: sustained low quality score ────────────────────
        if len(self._score_window) == _WINDOW:
            avg_score = sum(self._score_window) / _WINDOW
            if avg_score < _SCORE_THRESH:
                reason = "sustained_low_quality"
                if self._cooldown_ok(reason):
                    self._record_alert(reason)
                    logger.warning(
                        "OcclusionGuard: sustained low quality score=%.1f over %d frames",
                        avg_score, _WINDOW,
                    )
                    return self._build_alert(
                        reason,
                        f"Sustained low stream quality (avg score {avg_score:.0f}/100)",
                        quality,
                        severity="warning",
                    )

        return None

    @staticmethod
    def _build_alert(
        reason: str,
        message: str,
        quality: dict[str, Any],
        severity: str = "warning",
    ) -> dict[str, Any]:
        return {
            "reason": reason,
            "message": message,
            "severity": severity,
            "quality": quality,
            "detected_at": datetime.now(timezone.utc).isoformat(),
        }

    def reset(self) -> None:
        """Call when camera switches or stream restarts."""
        self._sharpness_window.clear()
        self._score_window.clear()
        self._consec_bad = 0
        self._last_alert_at.clear()
