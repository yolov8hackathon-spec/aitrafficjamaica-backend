"""
Train YOLO with stability-first defaults for fixed traffic-camera angles.

Usage:
  python scripts/train_yolo_stable.py --data dataset/data.yaml --model yolov8s.pt --epochs 100 --imgsz 960
"""
from __future__ import annotations

import argparse
from pathlib import Path

from ultralytics import YOLO


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Stability-focused YOLO training recipe")
    p.add_argument("--data", type=str, required=True, help="Path to data.yaml")
    p.add_argument("--model", type=str, default="yolov8s.pt", help="Base model (yolov8s.pt or yolov8m.pt)")
    p.add_argument("--epochs", type=int, default=100, help="Train epochs (recommended 80-120)")
    p.add_argument("--imgsz", type=int, default=960, help="Training image size (960 recommended)")
    p.add_argument("--batch", type=int, default=8, help="Batch size")
    p.add_argument("--device", type=str, default="0", help="CUDA device or cpu")
    p.add_argument("--project", type=str, default="runs/train", help="Output project dir")
    p.add_argument("--name", type=str, default="traffic_stable", help="Run name")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    data = Path(args.data)
    if not data.exists():
        raise SystemExit(f"data.yaml not found: {data}")

    model = YOLO(args.model)
    # Stability-first recipe: reduce aggressive transforms that can hurt box lock-on.
    model.train(
        data=str(data),
        epochs=int(args.epochs),
        imgsz=int(args.imgsz),
        batch=int(args.batch),
        device=str(args.device),
        project=str(args.project),
        name=str(args.name),
        cache=True,
        workers=8,
        optimizer="AdamW",
        cos_lr=True,
        close_mosaic=10,
        degrees=0.0,
        shear=0.0,
        perspective=0.0,
        fliplr=0.5,
        flipud=0.0,
        hsv_h=0.012,
        hsv_s=0.35,
        hsv_v=0.25,
        translate=0.06,
        scale=0.25,
        mixup=0.0,
        copy_paste=0.0,
        erasing=0.0,
    )

    print("Training complete.")
    print("Use best weights at: runs/train/<name>/weights/best.pt")


if __name__ == "__main__":
    main()
