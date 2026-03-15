# WHITELINEZ Backend (Railway)

## Railway Deploy Checklist
1. Create a Railway service from `whitelinez-backend/`.
2. Ensure build uses `requirements.txt` and starts FastAPI app (Railway/Nixpacks handles this from project defaults).
3. Add all required environment variables listed below.
4. Deploy and check `GET /health`.

## Required Environment Variables
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CAMERA_ALIAS`
- `WS_AUTH_SECRET`
- `ALLOWED_ORIGIN`

## Recommended Starter Variables
- `URL_REFRESH_INTERVAL=240`
- `YOLO_MODEL=yolov8s.pt`
- `YOLO_CONF=0.45`
- `COUNT_LINE_RATIO=0.55`
- `DB_SNAPSHOT_INTERVAL_SEC=0.75`
- `BET_LOCK_SECONDS=10`
- `WS_PORT=8000`

## Optional Live Dataset Capture (Auto-collect from stream)
- `AUTO_CAPTURE_ENABLED=1`
- `AUTO_CAPTURE_DATASET_ROOT=dataset`
- `AUTO_CAPTURE_CLASSES=car`
- `AUTO_CAPTURE_MIN_CONF=0.45`
- `AUTO_CAPTURE_COOLDOWN_SEC=5.0`
- `AUTO_CAPTURE_VAL_SPLIT=0.2`
- `AUTO_CAPTURE_JPEG_QUALITY=90`
- `AUTO_CAPTURE_MAX_BOXES_PER_FRAME=30`

When enabled, detected classes are written as YOLO files:
- `dataset/images/train/*.jpg`
- `dataset/images/val/*.jpg`
- `dataset/labels/train/*.txt`
- `dataset/labels/val/*.txt`

### Optional: Auto-upload Captures to Supabase Storage
- `AUTO_CAPTURE_UPLOAD_ENABLED=1`
- `AUTO_CAPTURE_UPLOAD_BUCKET=ml-datasets`
- `AUTO_CAPTURE_UPLOAD_PREFIX=datasets/live-capture`
- `AUTO_CAPTURE_DELETE_LOCAL_AFTER_UPLOAD=0`
- `AUTO_CAPTURE_UPLOAD_TIMEOUT_SEC=20`

Uploaded object layout:
- `<prefix>/images/{train|val}/{camera_id}/*.jpg`
- `<prefix>/labels/{train|val}/{camera_id}/*.txt`

## Quick Tuning (Safe)
- More responsive detection:
  - Lower `YOLO_CONF` slightly (example `0.40` to `0.45`).
- Lower backend DB pressure:
  - Increase `DB_SNAPSHOT_INTERVAL_SEC` (example `1.0`).
- Better freshness:
  - Keep `DB_SNAPSHOT_INTERVAL_SEC` between `0.5` and `1.0`.
- Stream lag feels behind real-time:
  - Confirm camera/source settings and keep low buffering at source.

## Health Check
- Endpoint: `/health`
- Expect:
  - `"status": "ok"`
  - AI/refresh/round/resolver tasks running
  - active WS connection counters when clients are connected

## Notes
- All timestamps in backend are stored in UTC.
- Frontend display is configured to Jamaica time (`America/Jamaica`).
