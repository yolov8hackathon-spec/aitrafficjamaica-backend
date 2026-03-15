"""
ai/tracker.py — Supervision ByteTracker wrapper.
Assigns persistent track IDs to detections across frames.
"""
import supervision as sv


class VehicleTracker:
    def __init__(self):
        self.tracker = sv.ByteTracker(
            track_activation_threshold=0.25,
            lost_track_buffer=30,
            minimum_matching_threshold=0.8,
            frame_rate=25,
        )

    def update(self, detections: sv.Detections) -> sv.Detections:
        """Update tracker and return detections with track IDs."""
        return self.tracker.update_with_detections(detections)
