FROM python:3.12-slim

# System deps for OpenCV and YOLO
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1. Pin numpy FIRST — a single version that every subsequent package resolves
#    against. Eliminates the dual-numpy ABI issue (cv2 / torch / supervision
#    each importing a different numpy module instance).
#    numpy 1.26.4 satisfies: ultralytics>=1.23, supervision>=1.21, scipy>=1.23.5
RUN pip install --no-cache-dir numpy==1.26.4

# 2. CUDA-enabled PyTorch (cu121 — compatible with CUDA 12.x injected by Railway GPU)
#    Falls back to CPU silently via detector.py if no GPU is attached.
RUN pip install --no-cache-dir \
    torch==2.3.1+cu121 \
    torchvision==0.18.1+cu121 \
    --index-url https://download.pytorch.org/whl/cu121

# 3. Remaining deps — all see numpy 1.26.4 already in site-packages
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download YOLO weights so they're baked in — avoids download on every cold start
# yolov8s.pt = YOLOv8 small model (21MB)
RUN python -c "from ultralytics import YOLO; YOLO('yolov8s.pt')"

# Clean pip cache to reduce image size
RUN pip cache purge

COPY . .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
