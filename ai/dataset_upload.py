"""
ai/dataset_upload.py - Upload live-captured dataset files to Supabase Storage.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)


class SupabaseDatasetUploader:
    def __init__(
        self,
        enabled: bool,
        supabase_url: str,
        service_role_key: str,
        bucket: str,
        prefix: str,
        timeout_sec: float,
        delete_local_after_upload: bool,
    ):
        self.enabled = bool(enabled)
        self.supabase_url = supabase_url.rstrip("/")
        self.service_role_key = service_role_key
        self.bucket = bucket
        self.prefix = prefix.strip("/ ")
        self.timeout_sec = float(max(5.0, timeout_sec))
        self.delete_local_after_upload = bool(delete_local_after_upload)

        if self.enabled:
            logger.info(
                "Live dataset upload enabled: bucket=%s prefix=%s delete_local=%s",
                self.bucket,
                self.prefix,
                self.delete_local_after_upload,
            )
        else:
            logger.info("Live dataset upload disabled")

    async def upload_capture(
        self,
        image_path: str,
        label_path: str,
        split: str,
        camera_id: str,
    ) -> dict:
        if not self.enabled:
            return {"ok": False, "error": "upload disabled"}

        image_file = Path(image_path)
        label_file = Path(label_path)
        if not image_file.exists() or not label_file.exists():
            logger.warning("Capture upload skipped: missing local files image=%s label=%s", image_path, label_path)
            return {"ok": False, "error": "missing local files"}

        remote_image = f"{self.prefix}/images/{split}/{camera_id}/{image_file.name}" if self.prefix else f"images/{split}/{camera_id}/{image_file.name}"
        remote_label = f"{self.prefix}/labels/{split}/{camera_id}/{label_file.name}" if self.prefix else f"labels/{split}/{camera_id}/{label_file.name}"

        image_bytes = await asyncio.to_thread(image_file.read_bytes)
        label_bytes = await asyncio.to_thread(label_file.read_bytes)

        try:
            async with httpx.AsyncClient(timeout=self.timeout_sec) as client:
                await self._upload_file(client, remote_image, image_bytes, "image/jpeg")
                await self._upload_file(client, remote_label, label_bytes, "text/plain; charset=utf-8")
        except Exception as exc:
            logger.warning("Capture upload failed image=%s label=%s error=%s", image_path, label_path, exc)
            return {
                "ok": False,
                "error": str(exc),
                "remote_image": remote_image,
                "remote_label": remote_label,
            }

        logger.info("Uploaded capture to storage: %s and %s", remote_image, remote_label)

        if self.delete_local_after_upload:
            for file_path in (image_file, label_file):
                try:
                    await asyncio.to_thread(file_path.unlink, True)
                except Exception as exc:
                    logger.warning("Could not delete local file %s after upload: %s", file_path, exc)

        return {
            "ok": True,
            "remote_image": remote_image,
            "remote_label": remote_label,
        }

    async def _upload_file(self, client: httpx.AsyncClient, object_path: str, content: bytes, content_type: str) -> None:
        encoded_path = quote(object_path, safe="/")
        endpoint = f"{self.supabase_url}/storage/v1/object/{self.bucket}/{encoded_path}"
        headers = {
            "apikey": self.service_role_key,
            "Authorization": f"Bearer {self.service_role_key}",
            "x-upsert": "true",
            "Content-Type": content_type,
        }
        response = await client.post(endpoint, headers=headers, content=content)
        if response.status_code >= 400:
            raise RuntimeError(f"storage upload error {response.status_code}: {response.text[:300]}")
