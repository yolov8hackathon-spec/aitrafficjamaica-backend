"""
ai/dataset_capture.py - Capture live frames into YOLO dataset format.

This is intentionally local-file based:
- images/{train,val}/*.jpg
- labels/{train,val}/*.txt
"""
from __future__ import annotations

import logging
import random
import re
import time
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from uuid import uuid4

import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _safe_name(text: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]+", "-", text).strip("-").lower() or "camera"


class LiveDatasetCapture:
    def __init__(
        self,
        enabled: bool,
        dataset_root: str,
        classes: list[str],
        min_conf: float,
        cooldown_sec: float,
        val_split: float,
        jpeg_quality: int,
        max_boxes_per_frame: int,
    ):
        self.enabled = bool(enabled)
        self.dataset_root = Path(dataset_root)
        self.classes = [c.strip().lower() for c in classes if c.strip()]
        self.class_to_idx = {name: idx for idx, name in enumerate(self.classes)}
        self.min_conf = float(min_conf)
        self.cooldown_sec = float(max(0.0, cooldown_sec))
        self.val_split = float(max(0.0, min(1.0, val_split)))
        self.jpeg_quality = int(max(40, min(100, jpeg_quality)))
        self.max_boxes_per_frame = int(max(1, max_boxes_per_frame))
        self._last_capture_mono = 0.0
        self._rng = random.Random()

        if self.enabled and not self.classes:
            logger.warning("AUTO_CAPTURE_ENABLED=1 but AUTO_CAPTURE_CLASSES is empty; disabling capture")
            self.enabled = False

        if self.enabled:
            for split in ("train", "val"):
                (self.dataset_root / "images" / split).mkdir(parents=True, exist_ok=True)
                (self.dataset_root / "labels" / split).mkdir(parents=True, exist_ok=True)
            logger.info(
                "Live dataset capture enabled: root=%s classes=%s cooldown=%.2fs",
                self.dataset_root,
                ",".join(self.classes),
                self.cooldown_sec,
            )
        else:
            logger.info("Live dataset capture disabled")

    def maybe_capture(self, frame: np.ndarray, detections: list[dict], camera_id: str) -> dict | None:
        if not self.enabled:
            return None

        now_mono = time.monotonic()
        if (now_mono - self._last_capture_mono) < self.cooldown_sec:
            return None

        label_lines: list[str] = []
        accepted = 0
        for det in detections:
            cls_name = str(det.get("cls", "")).strip().lower()
            if cls_name not in self.class_to_idx:
                continue

            conf_raw = det.get("conf")
            conf_val = float(conf_raw) if conf_raw is not None else 1.0
            if conf_val < self.min_conf:
                continue

            x1 = _clamp01(det.get("x1", 0.0))
            y1 = _clamp01(det.get("y1", 0.0))
            x2 = _clamp01(det.get("x2", 0.0))
            y2 = _clamp01(det.get("y2", 0.0))

            w = max(0.0, x2 - x1)
            h = max(0.0, y2 - y1)
            if w <= 0.0 or h <= 0.0:
                continue

            xc = x1 + (w / 2.0)
            yc = y1 + (h / 2.0)
            cls_idx = self.class_to_idx[cls_name]
            label_lines.append(f"{cls_idx} {xc:.6f} {yc:.6f} {w:.6f} {h:.6f}")
            accepted += 1
            if accepted >= self.max_boxes_per_frame:
                break

        if not label_lines:
            return None

        split = "val" if self._rng.random() < self.val_split else "train"
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        stem = f"{_safe_name(camera_id)}-{stamp}-{uuid4().hex[:8]}"

        image_path = self.dataset_root / "images" / split / f"{stem}.jpg"
        label_path = self.dataset_root / "labels" / split / f"{stem}.txt"

        frame_np = np.array(frame, dtype=np.uint8)
        frame_rgb = np.ascontiguousarray(frame_np[:, :, ::-1])  # BGR -> RGB
        img = Image.fromarray(frame_rgb)
        buf = BytesIO()
        img.save(buf, format="JPEG", quality=self.jpeg_quality)
        image_path.write_bytes(buf.getvalue())
        label_path.write_text("\n".join(label_lines) + "\n", encoding="utf-8")

        self._last_capture_mono = now_mono
        return {
            "split": split,
            "image_path": str(image_path),
            "label_path": str(label_path),
            "boxes": len(label_lines),
        }
