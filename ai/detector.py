"""
ai/detector.py - YOLOv8 vehicle detector using Ultralytics + Supervision.
COCO classes used: 2=car, 3=motorcycle, 5=bus, 7=truck
"""
import logging
import os

import numpy as np
import supervision as sv
import torch
from PIL import Image, ImageEnhance
from ultralytics import YOLO

logger = logging.getLogger(__name__)

# Populated from model.names at startup — do not hardcode
VEHICLE_CLASSES: list[int] = []
CLASS_NAMES: dict[int, str] = {}


class VehicleDetector:
    def __init__(
        self,
        model_path: str = "yolov8s.pt",
        conf_threshold: float = 0.50,
        infer_size: int | None = None,
        iou_threshold: float | None = None,
        max_det: int | None = None,
        device: str | None = None,
        tracker_yaml: str | None = None,
    ):
        requested_device = str(device or os.getenv("YOLO_DEVICE", "auto")).strip().lower()
        requested_device = requested_device.replace(" ", "")
        if requested_device in {"cuda(line0)", "cuda(line0).", "cudaline0", "cuda0"}:
            requested_device = "cuda:0"
        cuda_available = bool(torch.cuda.is_available())
        selected_device = "cpu"
        if requested_device in {"auto", "cuda", "gpu", "0", "cuda:0"}:
            selected_device = "cuda:0" if cuda_available else "cpu"
        elif requested_device == "cpu":
            selected_device = "cpu"
        elif requested_device.startswith("cuda"):
            selected_device = requested_device if cuda_available else "cpu"
        else:
            selected_device = requested_device or "cpu"

        if requested_device.startswith("cuda") and not cuda_available:
            logger.warning(
                "YOLO device requested as '%s' but CUDA is unavailable; falling back to CPU",
                requested_device,
            )

        self.device = selected_device
        self.cuda_available = cuda_available
        self.device_name = None
        if self.device.startswith("cuda") and cuda_available:
            try:
                self.device_name = torch.cuda.get_device_name(0)
            except Exception:
                self.device_name = "cuda"

        logger.info(
            "Loading YOLO model: %s (conf=%.2f, requested_device=%s, selected_device=%s, cuda_available=%s, cuda_name=%s)",
            model_path,
            conf_threshold,
            requested_device,
            self.device,
            self.cuda_available,
            self.device_name or "n/a",
        )

        self.model = YOLO(model_path)
        try:
            self.model.to(self.device)
        except Exception as exc:
            logger.warning(
                "Failed to move YOLO model to '%s' (%s). Falling back to CPU.",
                self.device,
                exc,
            )
            self.device = "cpu"
            self.device_name = None
            self.model.to("cpu")

        # Populate class maps from model metadata so they're always correct
        if hasattr(self.model, "names") and self.model.names:
            CLASS_NAMES.clear()
            CLASS_NAMES.update(self.model.names)
            VEHICLE_CLASSES[:] = sorted(self.model.names.keys())
        else:
            CLASS_NAMES.update({2: "car", 3: "motorcycle", 5: "bus", 7: "truck"})
            VEHICLE_CLASSES[:] = [2, 3, 5, 7]
        logger.info("Model classes: %s", CLASS_NAMES)
        self.conf = conf_threshold
        self.infer_size = int(infer_size or int(os.getenv("DETECT_INFER_SIZE", "448")))
        self.iou = float(iou_threshold if iou_threshold is not None else float(os.getenv("DETECT_IOU", "0.50")))
        self.max_det = int(max_det or int(os.getenv("DETECT_MAX_DET", "80")))
        self.night_light_track_enabled = int(os.getenv("NIGHT_LIGHT_TRACK_ENABLED", "1")) == 1
        self.night_light_brightness = float(os.getenv("NIGHT_LIGHT_BRIGHTNESS", "1.18"))
        self.night_light_contrast = float(os.getenv("NIGHT_LIGHT_CONTRAST", "1.22"))
        self.night_light_sharpness = float(os.getenv("NIGHT_LIGHT_SHARPNESS", "1.10"))
        self._night_mode = False
        raw_tracker = str(tracker_yaml or os.getenv("YOLO_TRACKER_YAML", "")).strip()
        self.tracker_yaml: str | None = raw_tracker if raw_tracker else None
        if self.tracker_yaml:
            logger.info("YOLO native tracker enabled: %s", self.tracker_yaml)

    def set_night_mode(self, enabled: bool) -> None:
        self._night_mode = bool(enabled)

    def detect(self, frame) -> sv.Detections:
        h, w = frame.shape[:2]
        scale = min(self.infer_size / h, self.infer_size / w)
        new_w, new_h = int(w * scale), int(h * scale)
        pad_top = (self.infer_size - new_h) // 2
        pad_left = (self.infer_size - new_w) // 2

        frame_np = np.array(frame, dtype=np.uint8)
        frame_rgb = np.ascontiguousarray(frame_np[:, :, ::-1])

        pil = Image.fromarray(frame_rgb)
        if self._night_mode and self.night_light_track_enabled:
            pil = ImageEnhance.Brightness(pil).enhance(self.night_light_brightness)
            pil = ImageEnhance.Contrast(pil).enhance(self.night_light_contrast)
            pil = ImageEnhance.Sharpness(pil).enhance(self.night_light_sharpness)
        pil = pil.resize((new_w, new_h), Image.BILINEAR)
        padded = Image.new("RGB", (self.infer_size, self.infer_size), (114, 114, 114))
        padded.paste(pil, (pad_left, pad_top))

        raw = padded.tobytes()
        tensor = (
            torch.frombuffer(bytearray(raw), dtype=torch.uint8)
            .reshape(self.infer_size, self.infer_size, 3)
            .to(dtype=torch.float32)
            .div(255.0)
            .permute(2, 0, 1)
            .unsqueeze(0)
        )
        tensor = tensor.to(self.device, non_blocking=self.device.startswith("cuda"))

        def _run_inference(t, dev):
            common = dict(
                source=t,
                conf=self.conf,
                iou=self.iou,
                max_det=self.max_det,
                classes=VEHICLE_CLASSES,
                agnostic_nms=True,   # suppress car+truck dual-detection on same vehicle
                verbose=False,
                device=dev,
            )
            if self.tracker_yaml:
                return self.model.track(persist=True, tracker=self.tracker_yaml, **common)[0]
            return self.model.predict(**common)[0]

        try:
            results = _run_inference(tensor, self.device)
        except Exception as exc:
            if self.device != "cpu":
                logger.warning(
                    "YOLO inference failed on device '%s' (%s). Retrying on CPU.",
                    self.device,
                    exc,
                )
                self.device = "cpu"
                self.device_name = None
                tensor = tensor.to("cpu")
                self.model.to("cpu")
                results = _run_inference(tensor, "cpu")
            else:
                raise

        boxes = results.boxes
        if boxes is not None and len(boxes):
            xyxy = np.array(boxes.xyxy.cpu().numpy(), dtype=np.float32)
            confidence = np.array(boxes.conf.cpu().numpy(), dtype=np.float32)
            class_id = np.array(boxes.cls.cpu().numpy(), dtype=np.int32)
            # Extract tracker IDs assigned by YOLO's native tracker (model.track)
            if self.tracker_yaml and boxes.id is not None:
                tracker_id = np.array(boxes.id.cpu().numpy(), dtype=np.int32)
            else:
                tracker_id = None
        else:
            xyxy = np.empty((0, 4), dtype=np.float32)
            confidence = np.empty((0,), dtype=np.float32)
            class_id = np.empty((0,), dtype=np.int32)
            tracker_id = None

        detections = sv.Detections(
            xyxy=xyxy,
            confidence=confidence,
            class_id=class_id,
        )
        if tracker_id is not None:
            detections.tracker_id = tracker_id

        if len(detections) > 0:
            detections.xyxy[:, [0, 2]] -= pad_left
            detections.xyxy[:, [1, 3]] -= pad_top
            detections.xyxy /= scale
            detections.xyxy[:, [0, 2]] = detections.xyxy[:, [0, 2]].clip(0, w)
            detections.xyxy[:, [1, 3]] = detections.xyxy[:, [1, 3]].clip(0, h)

        return detections

    @staticmethod
    def class_name(class_id: int) -> str:
        return CLASS_NAMES.get(class_id, "unknown")

    def runtime_info(self) -> dict:
        return {
            "device": self.device,
            "cuda_available": self.cuda_available,
            "device_name": self.device_name,
        }
