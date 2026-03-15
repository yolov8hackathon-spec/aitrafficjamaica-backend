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

# Install CPU-only PyTorch first to avoid pulling 2.5GB GPU build
RUN pip install --no-cache-dir \
    torch==2.2.2+cpu \
    torchvision==0.17.2+cpu \
    --index-url https://download.pytorch.org/whl/cpu

# Install remaining deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Clean pip cache to reduce image size
RUN pip cache purge

COPY . .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
