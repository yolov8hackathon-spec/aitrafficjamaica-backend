"""
ai/stream.py - HLS stream reader with exponential backoff reconnect.
Yields raw BGR frames from the live feed.
"""
import asyncio
import logging
from typing import AsyncGenerator

import cv2
import numpy as np

from config import get_config

logger = logging.getLogger(__name__)

MAX_BACKOFF      = 60.0
BASE_BACKOFF     = 2.0
_OPEN_TIMEOUT    = 15.0   # seconds — prevents hanging on unresponsive stream URL


class HLSStream:
    """OpenCV-based HLS reader with auto-reconnect."""

    def __init__(self, url: str):
        self.url = url
        self._cap: cv2.VideoCapture | None = None
        self._backoff = BASE_BACKOFF
        self._grab_latest = get_config().STREAM_GRAB_LATEST == 1

    def _open_blocking(self) -> bool:
        """Blocking open — call via asyncio.to_thread only."""
        if self._cap:
            self._cap.release()
        cap = cv2.VideoCapture(self.url)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        ok = cap.isOpened()
        if ok:
            self._cap = cap
            self._backoff = BASE_BACKOFF
            logger.info("Stream opened successfully")
        else:
            cap.release()
            logger.warning("Failed to open stream")
        return ok

    async def _open(self) -> bool:
        """
        Non-blocking open with timeout.
        Wraps the blocking cv2.VideoCapture call in a thread so it cannot
        freeze the asyncio event loop, and cancels after _OPEN_TIMEOUT seconds.
        """
        logger.info("Opening HLS stream: %s", self.url)
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(self._open_blocking),
                timeout=_OPEN_TIMEOUT,
            )
        except asyncio.TimeoutError:
            logger.warning("Stream open timed out after %.0fs — will retry", _OPEN_TIMEOUT)
            if self._cap:
                try:
                    self._cap.release()
                except Exception:
                    pass
                self._cap = None
            return False

    async def frames(self) -> AsyncGenerator[np.ndarray, None]:
        """
        Async generator that yields BGR frames.
        Reconnects with exponential backoff on failure.
        """
        while True:
            if not await self._open():
                await asyncio.sleep(self._backoff)
                self._backoff = min(self._backoff * 2, MAX_BACKOFF)
                continue

            while True:
                if self._grab_latest:
                    # Drop one queued frame when possible to reduce stale-latency feel.
                    await asyncio.to_thread(self._cap.grab)
                ret, frame = await asyncio.to_thread(self._cap.read)
                if not ret:
                    logger.warning("Frame read failed - reconnecting in %.1fs", self._backoff)
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
