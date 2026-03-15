"""
config.py — Fail-fast environment variable loader.
All required vars must be set at startup or the app crashes immediately.
"""
import os
from functools import lru_cache


class Config:
    # Supabase
    SUPABASE_URL: str
    SUPABASE_SERVICE_ROLE_KEY: str

    # Stream — permanent ipcamlive camera alias (never changes, no session expiry)
    CAMERA_ALIAS: str
    CAMERA_ALIASES: list[str]
    URL_REFRESH_INTERVAL: int  # seconds between proactive URL refreshes (default 240)

    # WebSocket auth (HMAC)
    WS_AUTH_SECRET: str
    ALLOWED_ORIGIN: str
    SUPABASE_JWT_AUDIENCE: str

    # AI config
    YOLO_MODEL: str
    YOLO_TRACKER_YAML: str
    YOLO_CONF: float
    DETECT_INFER_SIZE: int
    DETECT_IOU: float
    DETECT_MAX_DET: int
    NIGHT_PROFILE_ENABLED: int
    NIGHT_PROFILE_START_HOUR: int
    NIGHT_PROFILE_END_HOUR: int
    NIGHT_YOLO_CONF: float
    NIGHT_DETECT_INFER_SIZE: int
    NIGHT_DETECT_IOU: float
    NIGHT_DETECT_MAX_DET: int
    NIGHT_LIGHT_TRACK_ENABLED: int
    NIGHT_LIGHT_BRIGHTNESS: float
    NIGHT_LIGHT_CONTRAST: float
    NIGHT_LIGHT_SHARPNESS: float
    TRACK_ACTIVATION_THRESHOLD: float
    TRACK_LOST_BUFFER: int
    TRACK_MATCH_THRESHOLD: float
    TRACK_FRAME_RATE: int
    TRACK_FALLBACK_ENABLED: int
    TRACK_FALLBACK_MAX_CENTER_DIST_RATIO: float
    TRACK_FALLBACK_TTL_SEC: float
    COUNT_LINE_RATIO: float  # fallback ratio if no DB line
    DB_SNAPSHOT_INTERVAL_SEC: float
    STREAM_GRAB_LATEST: int
    OPENAI_API_KEY: str
    OPENAI_MODEL: str
    TRAINER_WEBHOOK_URL: str
    TRAINER_WEBHOOK_SECRET: str
    TRAINER_DATASET_YAML_URL: str
    TRAINER_EPOCHS: int
    TRAINER_IMGSZ: int
    TRAINER_BATCH: int
    ML_TELEMETRY_ENABLED: int   # set to 0 to stop ml_detection_events inserts
    ML_AUTO_RETRAIN_ENABLED: int
    ML_AUTO_RETRAIN_INTERVAL_MIN: int
    ML_AUTO_RETRAIN_HOURS: int
    ML_AUTO_RETRAIN_MIN_ROWS: int
    ML_AUTO_RETRAIN_MIN_SCORE_GAIN: float
    AUTO_CAPTURE_ENABLED: int
    AUTO_CAPTURE_DATASET_ROOT: str
    AUTO_CAPTURE_CLASSES: str
    AUTO_CAPTURE_MIN_CONF: float
    AUTO_CAPTURE_COOLDOWN_SEC: float
    AUTO_CAPTURE_VAL_SPLIT: float
    AUTO_CAPTURE_JPEG_QUALITY: int
    AUTO_CAPTURE_MAX_BOXES_PER_FRAME: int
    AUTO_CAPTURE_UPLOAD_ENABLED: int
    AUTO_CAPTURE_UPLOAD_BUCKET: str
    AUTO_CAPTURE_UPLOAD_PREFIX: str
    AUTO_CAPTURE_DELETE_LOCAL_AFTER_UPLOAD: int
    AUTO_CAPTURE_UPLOAD_TIMEOUT_SEC: float

    # Bet logic
    BET_LOCK_SECONDS: int

    # Demo detection
    DEMO_SECRET: str

    # Server
    WS_PORT: int

    def __init__(self):
        required = [
            "SUPABASE_URL",
            "SUPABASE_SERVICE_ROLE_KEY",
            "CAMERA_ALIAS",
            "WS_AUTH_SECRET",
            "ALLOWED_ORIGIN",
        ]
        missing = [k for k in required if not os.getenv(k)]
        if missing:
            raise RuntimeError(
                f"[STARTUP FAILURE] Missing required environment variables: {missing}"
            )

        self.SUPABASE_URL = os.environ["SUPABASE_URL"]
        self.SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        self.CAMERA_ALIAS = os.environ["CAMERA_ALIAS"]
        raw_aliases = os.getenv("CAMERA_ALIASES", "")
        parsed_aliases = [a.strip() for a in raw_aliases.split(",") if a.strip()]
        self.CAMERA_ALIASES = parsed_aliases
        self.WS_AUTH_SECRET = os.environ["WS_AUTH_SECRET"]
        self.ALLOWED_ORIGIN = os.environ["ALLOWED_ORIGIN"]
        self.SUPABASE_JWT_AUDIENCE = os.getenv("SUPABASE_JWT_AUDIENCE", "authenticated")

        self.URL_REFRESH_INTERVAL = int(os.getenv("URL_REFRESH_INTERVAL", "240"))
        self.YOLO_MODEL = os.getenv("YOLO_MODEL", "yolov8n.pt")           # nano: 3-4x faster on CPU vs small
        self.YOLO_TRACKER_YAML = os.getenv("YOLO_TRACKER_YAML", "")
        self.YOLO_CONF = float(os.getenv("YOLO_CONF", "0.35"))
        self.DETECT_INFER_SIZE = int(os.getenv("DETECT_INFER_SIZE", "320"))   # was 960; 320 = ~9x faster on CPU
        self.DETECT_IOU = float(os.getenv("DETECT_IOU", "0.50"))
        self.DETECT_MAX_DET = int(os.getenv("DETECT_MAX_DET", "80"))
        self.NIGHT_PROFILE_ENABLED = int(os.getenv("NIGHT_PROFILE_ENABLED", "1"))
        self.NIGHT_PROFILE_START_HOUR = int(os.getenv("NIGHT_PROFILE_START_HOUR", "18"))
        self.NIGHT_PROFILE_END_HOUR = int(os.getenv("NIGHT_PROFILE_END_HOUR", "6"))
        self.NIGHT_YOLO_CONF = float(os.getenv("NIGHT_YOLO_CONF", "0.30"))
        self.NIGHT_DETECT_INFER_SIZE = int(os.getenv("NIGHT_DETECT_INFER_SIZE", "416"))  # was 640
        self.NIGHT_DETECT_IOU = float(os.getenv("NIGHT_DETECT_IOU", "0.45"))
        self.NIGHT_DETECT_MAX_DET = int(os.getenv("NIGHT_DETECT_MAX_DET", "120"))
        self.NIGHT_LIGHT_TRACK_ENABLED = int(os.getenv("NIGHT_LIGHT_TRACK_ENABLED", "1"))
        self.NIGHT_LIGHT_BRIGHTNESS = float(os.getenv("NIGHT_LIGHT_BRIGHTNESS", "1.18"))
        self.NIGHT_LIGHT_CONTRAST = float(os.getenv("NIGHT_LIGHT_CONTRAST", "1.22"))
        self.NIGHT_LIGHT_SHARPNESS = float(os.getenv("NIGHT_LIGHT_SHARPNESS", "1.10"))
        self.TRACK_ACTIVATION_THRESHOLD = float(os.getenv("TRACK_ACTIVATION_THRESHOLD", "0.2"))
        self.TRACK_LOST_BUFFER = int(os.getenv("TRACK_LOST_BUFFER", "5"))    # was 20; scaled to ~3fps processing rate
        self.TRACK_MATCH_THRESHOLD = float(os.getenv("TRACK_MATCH_THRESHOLD", "0.65"))
        self.TRACK_FRAME_RATE = int(os.getenv("TRACK_FRAME_RATE", "3"))      # was 25; matches real CPU processing FPS
        self.TRACK_FALLBACK_ENABLED = int(os.getenv("TRACK_FALLBACK_ENABLED", "1"))
        self.TRACK_FALLBACK_MAX_CENTER_DIST_RATIO = float(
            os.getenv("TRACK_FALLBACK_MAX_CENTER_DIST_RATIO", "0.08")
        )
        self.TRACK_FALLBACK_TTL_SEC = float(os.getenv("TRACK_FALLBACK_TTL_SEC", "2.0"))  # was 1.5; more gap between frames
        self.COUNT_LINE_RATIO = float(os.getenv("COUNT_LINE_RATIO", "0.55"))
        self.DB_SNAPSHOT_INTERVAL_SEC = float(os.getenv("DB_SNAPSHOT_INTERVAL_SEC", "0.75"))
        self.STREAM_GRAB_LATEST = int(os.getenv("STREAM_GRAB_LATEST", "1"))
        self.OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
        self.OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        self.TRAINER_WEBHOOK_URL = os.getenv("TRAINER_WEBHOOK_URL", "")
        self.TRAINER_WEBHOOK_SECRET = os.getenv("TRAINER_WEBHOOK_SECRET", "")
        self.TRAINER_DATASET_YAML_URL = os.getenv("TRAINER_DATASET_YAML_URL", "")
        self.TRAINER_EPOCHS = int(os.getenv("TRAINER_EPOCHS", "20"))
        self.TRAINER_IMGSZ = int(os.getenv("TRAINER_IMGSZ", "640"))
        self.TRAINER_BATCH = int(os.getenv("TRAINER_BATCH", "16"))
        self.ML_TELEMETRY_ENABLED = int(os.getenv("ML_TELEMETRY_ENABLED", "0"))
        self.ML_AUTO_RETRAIN_ENABLED = int(os.getenv("ML_AUTO_RETRAIN_ENABLED", "0"))
        self.ML_AUTO_RETRAIN_INTERVAL_MIN = int(os.getenv("ML_AUTO_RETRAIN_INTERVAL_MIN", "180"))
        self.ML_AUTO_RETRAIN_HOURS = int(os.getenv("ML_AUTO_RETRAIN_HOURS", "24"))
        self.ML_AUTO_RETRAIN_MIN_ROWS = int(os.getenv("ML_AUTO_RETRAIN_MIN_ROWS", "1000"))
        self.ML_AUTO_RETRAIN_MIN_SCORE_GAIN = float(os.getenv("ML_AUTO_RETRAIN_MIN_SCORE_GAIN", "0.015"))
        self.AUTO_CAPTURE_ENABLED = int(os.getenv("AUTO_CAPTURE_ENABLED", "0"))
        self.AUTO_CAPTURE_DATASET_ROOT = os.getenv("AUTO_CAPTURE_DATASET_ROOT", "dataset")
        self.AUTO_CAPTURE_CLASSES = os.getenv("AUTO_CAPTURE_CLASSES", "car")
        self.AUTO_CAPTURE_MIN_CONF = float(os.getenv("AUTO_CAPTURE_MIN_CONF", "0.45"))
        self.AUTO_CAPTURE_COOLDOWN_SEC = float(os.getenv("AUTO_CAPTURE_COOLDOWN_SEC", "5.0"))
        self.AUTO_CAPTURE_VAL_SPLIT = float(os.getenv("AUTO_CAPTURE_VAL_SPLIT", "0.2"))
        self.AUTO_CAPTURE_JPEG_QUALITY = int(os.getenv("AUTO_CAPTURE_JPEG_QUALITY", "90"))
        self.AUTO_CAPTURE_MAX_BOXES_PER_FRAME = int(os.getenv("AUTO_CAPTURE_MAX_BOXES_PER_FRAME", "30"))
        self.AUTO_CAPTURE_UPLOAD_ENABLED = int(os.getenv("AUTO_CAPTURE_UPLOAD_ENABLED", "0"))
        self.AUTO_CAPTURE_UPLOAD_BUCKET = os.getenv("AUTO_CAPTURE_UPLOAD_BUCKET", "ml-datasets")
        self.AUTO_CAPTURE_UPLOAD_PREFIX = os.getenv("AUTO_CAPTURE_UPLOAD_PREFIX", "datasets/live-capture")
        self.AUTO_CAPTURE_DELETE_LOCAL_AFTER_UPLOAD = int(os.getenv("AUTO_CAPTURE_DELETE_LOCAL_AFTER_UPLOAD", "0"))
        self.AUTO_CAPTURE_UPLOAD_TIMEOUT_SEC = float(os.getenv("AUTO_CAPTURE_UPLOAD_TIMEOUT_SEC", "20"))
        self.BET_LOCK_SECONDS = int(os.getenv("BET_LOCK_SECONDS", "10"))
        self.WS_PORT = int(os.getenv("WS_PORT", "8000"))
        # Frontend URL — used to rewrite HLS segment URLs through the Vercel proxy so
        # the upstream camera CDN URL is never sent to the browser.
        # Set to the Vercel deployment URL, e.g. https://your-app.vercel.app
        # Leave empty to fall back to passthrough (segments served directly from CDN).
        self.FRONTEND_URL = os.getenv("FRONTEND_URL", "").rstrip("/")
        # Demo detection secret — shared between Vercel functions and backend
        # Set any random string in Railway + Vercel env vars
        self.DEMO_SECRET = os.getenv("DEMO_SECRET", "")


@lru_cache(maxsize=1)
def get_config() -> Config:
    return Config()
