"""
ai/tracker.py - Supervision ByteTrack wrapper.
Assigns persistent track IDs to detections across frames.
"""
import time

import numpy as np
import supervision as sv

from config import get_config


class VehicleTracker:
    def __init__(self):
        cfg = get_config()
        self._track_activation_threshold = cfg.TRACK_ACTIVATION_THRESHOLD
        self._track_match_threshold = cfg.TRACK_MATCH_THRESHOLD
        self._track_frame_rate = cfg.TRACK_FRAME_RATE
        self._lost_track_buffer = int(cfg.TRACK_LOST_BUFFER)
        self.tracker = sv.ByteTrack(
            track_activation_threshold=self._track_activation_threshold,
            lost_track_buffer=self._lost_track_buffer,   # keep IDs stable through brief occlusions/frame drops
            minimum_matching_threshold=self._track_match_threshold,
            frame_rate=self._track_frame_rate,
        )
        self.fallback_enabled = int(getattr(cfg, "TRACK_FALLBACK_ENABLED", 1) or 0) == 1
        self.fallback_dist_ratio_day = float(
            getattr(cfg, "TRACK_FALLBACK_MAX_CENTER_DIST_RATIO", 0.08) or 0.08
        )
        self.fallback_ttl_sec = float(getattr(cfg, "TRACK_FALLBACK_TTL_SEC", 1.5) or 1.5)
        self.fallback_dist_ratio_night = self.fallback_dist_ratio_day * 1.35
        self._night_mode = False
        self._fallback_next_id = 10_000_000
        self._tracks: dict[int, tuple[float, float, float]] = {}

    def _rebuild_tracker(self, lost_buffer: int) -> None:
        self._lost_track_buffer = int(max(1, lost_buffer))
        self.tracker = sv.ByteTrack(
            track_activation_threshold=self._track_activation_threshold,
            lost_track_buffer=self._lost_track_buffer,
            minimum_matching_threshold=self._track_match_threshold,
            frame_rate=self._track_frame_rate,
        )

    def apply_runtime_profile(self, profile: dict) -> None:
        """
        Apply runtime tracking tuning from adaptive profile.
        Supported keys:
        - lost_buffer
        - fallback_ttl_sec
        - fallback_dist_ratio
        """
        if not isinstance(profile, dict):
            return

        lost_buffer = profile.get("lost_buffer")
        if lost_buffer is not None:
            try:
                lb = int(lost_buffer)
                if lb != self._lost_track_buffer:
                    self._rebuild_tracker(lb)
            except Exception:
                pass

        ttl = profile.get("fallback_ttl_sec")
        if ttl is not None:
            try:
                self.fallback_ttl_sec = max(0.2, float(ttl))
            except Exception:
                pass

        dist_ratio = profile.get("fallback_dist_ratio")
        if dist_ratio is not None:
            try:
                base = max(0.01, min(0.3, float(dist_ratio)))
                self.fallback_dist_ratio_day = base
                self.fallback_dist_ratio_night = base * 1.35
            except Exception:
                pass

    def set_night_mode(self, enabled: bool) -> None:
        self._night_mode = bool(enabled)

    @staticmethod
    def _centers(xyxy: np.ndarray) -> np.ndarray:
        centers = np.zeros((len(xyxy), 2), dtype=np.float32)
        if len(xyxy) == 0:
            return centers
        centers[:, 0] = (xyxy[:, 0] + xyxy[:, 2]) * 0.5
        centers[:, 1] = (xyxy[:, 1] + xyxy[:, 3]) * 0.5
        return centers

    def _cleanup_stale(self, now_mono: float) -> None:
        stale = [tid for tid, (_, _, ts) in self._tracks.items() if (now_mono - ts) > self.fallback_ttl_sec]
        for tid in stale:
            self._tracks.pop(tid, None)

    def _assign_fallback_ids(self, detections: sv.Detections) -> sv.Detections:
        n = len(detections)
        if n == 0:
            return detections

        now_mono = time.monotonic()
        self._cleanup_stale(now_mono)

        base_ids = getattr(detections, "tracker_id", None)
        if base_ids is None or len(base_ids) != n:
            tracker_ids = np.full((n,), -1, dtype=np.int32)
        else:
            tracker_ids = np.array(base_ids, dtype=np.int64, copy=True)

        xyxy = np.array(detections.xyxy, dtype=np.float32, copy=False)
        centers = self._centers(xyxy)

        for i in range(n):
            tid = int(tracker_ids[i])
            if tid >= 0:
                self._tracks[tid] = (float(centers[i, 0]), float(centers[i, 1]), now_mono)

        diag = float(np.hypot(np.max(xyxy[:, 2]) - np.min(xyxy[:, 0]), np.max(xyxy[:, 3]) - np.min(xyxy[:, 1])))
        if not np.isfinite(diag) or diag <= 0:
            diag = 1.0
        dist_ratio = self.fallback_dist_ratio_night if self._night_mode else self.fallback_dist_ratio_day
        max_dist = diag * max(0.01, dist_ratio)

        used_existing: set[int] = set()
        for i in range(n):
            if int(tracker_ids[i]) >= 0:
                continue

            cx, cy = float(centers[i, 0]), float(centers[i, 1])
            best_tid = None
            best_dist = None
            for tid, (tx, ty, ts) in self._tracks.items():
                if tid in used_existing:
                    continue
                if (now_mono - ts) > self.fallback_ttl_sec:
                    continue
                d = float(np.hypot(cx - tx, cy - ty))
                if d > max_dist:
                    continue
                if best_dist is None or d < best_dist:
                    best_dist = d
                    best_tid = tid

            if best_tid is None:
                best_tid = self._fallback_next_id
                self._fallback_next_id += 1

            tracker_ids[i] = best_tid
            used_existing.add(int(best_tid))
            self._tracks[int(best_tid)] = (cx, cy, now_mono)

        detections.tracker_id = tracker_ids.astype(np.int32)
        return detections

    def update(self, detections: sv.Detections) -> sv.Detections:
        """Update tracker and return detections with track IDs.

        If YOLO's native tracker (model.track) already assigned IDs,
        bypass sv.ByteTrack and go straight to fallback assignment.
        """
        native_ids = getattr(detections, "tracker_id", None)
        native_tracked = (
            native_ids is not None
            and len(native_ids) == len(detections)
            and len(detections) > 0
        )
        if native_tracked:
            tracked = detections
        else:
            tracked = self.tracker.update_with_detections(detections)
        if not self.fallback_enabled:
            return tracked
        return self._assign_fallback_ids(tracked)
