"""
ai/stream.py — HLS stream reader with exponential backoff reconnect.
Yields raw BGR frames from the live feed.
"""
import asyncio
import logging
import time
from typing import AsyncGenerator

import cv2
import numpy as np

logger = logging.getLogger(__name__)

MAX_BACKOFF = 60.0
BASE_BACKOFF = 2.0


class HLSStream:
    """OpenCV-based HLS reader with auto-reconnect."""

    def __init__(self, url: str):
        self.url = url
        self._cap: cv2.VideoCapture | None = None
        self._backoff = BASE_BACKOFF

    def _open(self) -> bool:
        if self._cap:
            self._cap.release()
        logger.info("Opening HLS stream: %s", self.url)
        self._cap = cv2.VideoCapture(self.url)
        # FFMPEG backend, minimal buffering
        self._cap.set(cv2.CAP_PROP_BUFFERSIZE, 3)
        ok = self._cap.isOpened()
        if ok:
            self._backoff = BASE_BACKOFF
            logger.info("Stream opened successfully")
        else:
            logger.warning("Failed to open stream")
        return ok

    async def frames(self) -> AsyncGenerator[np.ndarray, None]:
        """
        Async generator that yields BGR frames.
        Reconnects with exponential backoff on failure.
        """
        while True:
            if not self._open():
                await asyncio.sleep(self._backoff)
                self._backoff = min(self._backoff * 2, MAX_BACKOFF)
                continue

            while True:
                ret, frame = self._cap.read()
                if not ret:
                    logger.warning("Frame read failed — reconnecting in %.1fs", self._backoff)
                    break
                yield frame
                # Yield control so asyncio can process other tasks
                await asyncio.sleep(0)

            await asyncio.sleep(self._backoff)
            self._backoff = min(self._backoff * 2, MAX_BACKOFF)

    def release(self) -> None:
        if self._cap:
            self._cap.release()
            self._cap = None
