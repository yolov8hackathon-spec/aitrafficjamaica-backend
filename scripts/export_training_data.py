"""
scripts/export_training_data.py — Export annotated frames as a YOLO dataset.

Downloads frames from Supabase Storage (bucket: ml-training-frames) along with
their annotations from the ml_training_jobs table, then writes a YOLO-format
dataset directory:

    output_dir/
        images/train/   *.jpg
        images/val/     *.jpg   (val_split fraction)
        labels/train/   *.txt
        labels/val/     *.txt
        data.yaml

Usage:
    python -m scripts.export_training_data --out ./dataset --val-split 0.15
    python -m scripts.export_training_data --out ./dataset --limit 2000
"""
import argparse
import asyncio
import os
import random
import sys
from pathlib import Path
from typing import Any

from config import get_config

_BUCKET = "ml-training-frames"
_YOLO_CLASSES = ["car", "truck", "bus", "motorcycle"]
_CLASS_IDX = {cls: i for i, cls in enumerate(_YOLO_CLASSES)}


async def _fetch_annotated_frames(sb, limit: int) -> list[dict[str, Any]]:
    resp = await (
        sb.table("ml_training_jobs")
        .select("id, frame_path, annotations, status")
        .eq("status", "annotated")
        .limit(limit)
        .execute()
    )
    return resp.data or []


def _annotation_to_yolo(ann: dict[str, Any], img_w: int, img_h: int) -> str | None:
    """Convert a bounding box annotation dict to a YOLO label line."""
    cls_name = str(ann.get("class") or ann.get("cls") or "").lower()
    cls_idx = _CLASS_IDX.get(cls_name)
    if cls_idx is None:
        return None

    # Support both [x1,y1,x2,y2] and {x,y,w,h} formats
    if "x1" in ann:
        x1, y1 = float(ann["x1"]), float(ann["y1"])
        x2, y2 = float(ann["x2"]), float(ann["y2"])
    elif "x" in ann and "w" in ann:
        x1 = float(ann["x"])
        y1 = float(ann["y"])
        x2 = x1 + float(ann["w"])
        y2 = y1 + float(ann["h"])
    else:
        return None

    cx = ((x1 + x2) / 2) / img_w
    cy = ((y1 + y2) / 2) / img_h
    bw = (x2 - x1) / img_w
    bh = (y2 - y1) / img_h

    if any(v < 0 or v > 1 for v in (cx, cy, bw, bh)):
        return None

    return f"{cls_idx} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}"


async def export(output_dir: Path, val_split: float = 0.15, limit: int = 10000) -> None:
    from supabase_client import get_supabase
    import httpx

    sb = await get_supabase()
    frames = await _fetch_annotated_frames(sb, limit)
    if not frames:
        print("No annotated frames found.", file=sys.stderr)
        return

    print(f"Exporting {len(frames)} frames...")
    random.shuffle(frames)

    split_idx = max(1, int(len(frames) * (1 - val_split)))
    train_frames = frames[:split_idx]
    val_frames   = frames[split_idx:]

    for split, flist in [("train", train_frames), ("val", val_frames)]:
        (output_dir / "images" / split).mkdir(parents=True, exist_ok=True)
        (output_dir / "labels" / split).mkdir(parents=True, exist_ok=True)

    # Get signed URLs and download
    cfg = get_config()
    storage_url_base = f"{cfg.SUPABASE_URL}/storage/v1/object/public/{_BUCKET}"

    async with httpx.AsyncClient(timeout=30) as client:
        for split, flist in [("train", train_frames), ("val", val_frames)]:
            img_dir = output_dir / "images" / split
            lbl_dir = output_dir / "labels" / split

            for frame in flist:
                frame_path = frame.get("frame_path") or ""
                if not frame_path:
                    continue
                stem = Path(frame_path).stem

                # Download image
                url = f"{storage_url_base}/{frame_path}"
                try:
                    r = await client.get(url)
                    if r.status_code != 200:
                        continue
                    img_bytes = r.content
                except Exception as exc:
                    print(f"  skip {frame_path}: {exc}", file=sys.stderr)
                    continue

                # Detect image dimensions (JPEG SOF)
                img_w, img_h = 1920, 1080   # fallback
                try:
                    import struct
                    i = 0
                    while i < len(img_bytes):
                        if img_bytes[i:i+2] == b'\xff\xc0':
                            img_h, img_w = struct.unpack(">HH", img_bytes[i+5:i+9])
                            break
                        i += 1
                except Exception:
                    pass

                # Write image
                (img_dir / f"{stem}.jpg").write_bytes(img_bytes)

                # Write YOLO label
                annotations = frame.get("annotations") or []
                lines = []
                for ann in (annotations if isinstance(annotations, list) else []):
                    line = _annotation_to_yolo(ann, img_w, img_h)
                    if line:
                        lines.append(line)
                (lbl_dir / f"{stem}.txt").write_text("\n".join(lines))

    # Write data.yaml
    data_yaml = (
        f"path: {output_dir.resolve()}\n"
        f"train: images/train\n"
        f"val: images/val\n"
        f"nc: {len(_YOLO_CLASSES)}\n"
        f"names: {_YOLO_CLASSES}\n"
    )
    (output_dir / "data.yaml").write_text(data_yaml)

    print(f"Done. train={len(train_frames)} val={len(val_frames)}")
    print(f"Dataset written to: {output_dir.resolve()}")
    print(f"data.yaml: {output_dir / 'data.yaml'}")


async def _main() -> None:
    parser = argparse.ArgumentParser(description="Export YOLO training dataset from Supabase.")
    parser.add_argument("--out",       type=Path, default=Path("./dataset"), help="Output directory")
    parser.add_argument("--val-split", type=float, default=0.15,             help="Validation split fraction (default: 0.15)")
    parser.add_argument("--limit",     type=int,   default=10000,            help="Max frames to export (default: 10000)")
    args = parser.parse_args()

    await export(args.out, val_split=args.val_split, limit=args.limit)


if __name__ == "__main__":
    asyncio.run(_main())
