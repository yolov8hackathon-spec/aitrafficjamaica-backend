FROM python:3.12-slim

# System deps for OpenCV and YOLO (headless — no display needed on server)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1. Pin numpy FIRST — prevents dual-numpy ABI issue across cv2/torch/supervision
RUN pip install --no-cache-dir numpy==1.26.4

# 2. CPU-only PyTorch — Railway has no GPU on standard plans; saves ~2.3GB vs cu121
RUN pip install --no-cache-dir \
    torch==2.3.1+cpu \
    torchvision==0.18.1+cpu \
    --index-url https://download.pytorch.org/whl/cpu

# 3. Remaining deps — all see numpy 1.26.4 already in site-packages
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download yolov8s.pt weights — baked in to avoid cold-start download
RUN python -c "from ultralytics import YOLO; YOLO('yolov8s.pt')"

COPY . .

# Remove dev/test artifacts to keep image lean
RUN rm -rf \
    __pycache__ \
    */__pycache__ \
    testsprite_tests \
    scripts \
    .git \
    public/node_modules

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
