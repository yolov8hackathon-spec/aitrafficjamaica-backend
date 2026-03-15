"""
services/anomaly_service.py — Rolling statistical anomaly detection on vehicle counts.

Uses Welford's online algorithm to maintain a running mean and variance over
the last _WINDOW count readings. Fires an alert when the current count
deviates by more than _Z_THRESH standard deviations from the rolling mean.

Integration: call detector.feed(count, camera_id) each frame from the AI loop.
Zero latency, fires WS broadcast immediately.

Broadcasts {"type": "count_anomaly", ...} via manager.broadcast_public().
"""
import logging
from collections import deque
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

_WINDOW             = 60    # rolling window size (count readings)
_MIN_SAMPLES        = 15    # minimum samples before anomaly detection activates
_Z_THRESH           = 3.0   # z-score threshold (3σ ≈ 0.27% false-positive rate)
_ALERT_COOLDOWN_SEC = 90    # minimum seconds between anomaly alerts per camera


class CountAnomalyDetector:
    """
    Welford online mean/variance over a sliding window of vehicle counts.
    One instance per camera (or share a single instance for the active AI cam).
    """

    def __init__(self, camera_id: str = "") -> None:
        self.camera_id = camera_id
        self._window: deque[float] = deque(maxlen=_WINDOW)
        self._n = 0
        self._mean = 0.0
        self._m2 = 0.0           # Welford accumulator
        self._last_alert_at: float = 0.0

    def feed(self, count: float) -> dict[str, Any] | None:
        """
        Feed a new count reading. Returns an alert dict if anomalous, else None.
        Thread-safe for single-producer use (AI loop is single-threaded).
        """
        import time

        old_val = None
        if len(self._window) == _WINDOW:
            old_val = self._window[0]   # value about to be evicted

        self._window.append(float(count))
        self._n = min(self._n + 1, _WINDOW)

        # Welford update (approximate sliding — recompute on eviction)
        if old_val is not None:
            self._recompute()
        else:
            delta = count - self._mean
            self._mean += delta / self._n
            delta2 = count - self._mean
            self._m2 += delta * delta2

        if self._n < _MIN_SAMPLES:
            return None

        variance = self._m2 / self._n
        std = variance ** 0.5
        if std < 1e-6:
            return None

        z = abs(count - self._mean) / std
        if z < _Z_THRESH:
            return None

        now = time.monotonic()
        if (now - self._last_alert_at) < _ALERT_COOLDOWN_SEC:
            return None
        self._last_alert_at = now

        direction = "spike" if count > self._mean else "drop"
        logger.warning(
            "AnomalyDetector camera=%s count=%.0f mean=%.1f std=%.1f z=%.2f [%s]",
            self.camera_id, count, self._mean, std, z, direction,
        )
        return {
            "camera_id": self.camera_id,
            "count": count,
            "rolling_mean": round(self._mean, 1),
            "rolling_std": round(std, 1),
            "z_score": round(z, 2),
            "direction": direction,
            "detected_at": datetime.now(timezone.utc).isoformat(),
        }

    def _recompute(self) -> None:
        """Full recompute of mean/M2 from current window (on eviction)."""
        vals = list(self._window)
        n = len(vals)
        if n == 0:
            self._mean = 0.0
            self._m2 = 0.0
            self._n = 0
            return
        mean = sum(vals) / n
        m2 = sum((v - mean) ** 2 for v in vals)
        self._mean = mean
        self._m2 = m2
        self._n = n

    def reset(self) -> None:
        self._window.clear()
        self._n = 0
        self._mean = 0.0
        self._m2 = 0.0
        self._last_alert_at = 0.0

