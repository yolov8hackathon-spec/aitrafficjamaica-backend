"""
ai/url_refresher.py - Proactively fetches fresh HLS URLs from ipcamlive or YouTube.

ipcamlive flow:
  1. registerviewer.php (get viewerid)
  2. getcamerastreamstate.php (get stream state/details)
  3. Build HLS URL and validate it before use.

YouTube flow:
  - yt-dlp --get-url to extract the HLS manifest URL from a live stream.
  - URLs last ~6-8h; refreshed every 2h.
"""
import asyncio
import base64
import logging
import os
import time

import httpx

logger = logging.getLogger(__name__)

IPCAM_API_BASE = "https://g3.ipcamlive.com/player"
_REQUEST_HEADERS = {
    "Referer": "https://g3.ipcamlive.com/player/player.php",
    "User-Agent": (
        "Mozilla/5.0 (Linux; Android 13; SM-G981B) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36"
    ),
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
}

_current_url: str | None = None
_current_alias: str | None = None
_force_refresh_event: asyncio.Event | None = None
_yt_url_fetched_at: float = 0.0   # epoch seconds; used to skip re-fetch when URL is fresh


def get_current_url() -> str | None:
    return _current_url


def get_current_alias() -> str | None:
    return _current_alias


def _get_or_create_event() -> asyncio.Event:
    global _force_refresh_event
    if _force_refresh_event is None:
        _force_refresh_event = asyncio.Event()
    return _force_refresh_event


def trigger_force_refresh() -> None:
    """Signal url_refresh_loop to skip its current sleep and run immediately."""
    try:
        _get_or_create_event().set()
    except Exception:
        pass  # no running event loop yet, or other transient error — non-fatal


def _make_token() -> str:
    return base64.b64encode(os.urandom(32)).decode()


def _build_stream_url(details: dict) -> str | None:
    from urllib.parse import urlparse, urlunparse
    if str(details.get("streamavailable", "")) != "1":
        logger.warning("Camera reports streamavailable=0")
        return None

    address  = str(details.get("address", "")).strip().rstrip("/")
    streamid = str(details.get("streamid", "")).strip()
    if not address or not streamid:
        logger.warning("Missing address/streamid in stream state details")
        return None

    # Force HTTPS using proper URL parsing — avoids partial replace bugs
    try:
        parsed = urlparse(address if "://" in address else f"https://{address}")
        if parsed.scheme not in ("http", "https"):
            logger.warning("Unexpected stream address scheme: %s", parsed.scheme)
            return None
        safe_address = urlunparse(parsed._replace(scheme="https"))
        url = f"{safe_address.rstrip('/')}/streams/{streamid}/stream.m3u8"
        # Final sanity check — must be an absolute https URL
        final = urlparse(url)
        if final.scheme != "https" or not final.netloc:
            logger.warning("Rejecting malformed stream URL: %s", url)
            return None
        return url
    except Exception as exc:
        logger.warning("Failed to build stream URL: %s", exc)
        return None


async def _validate_manifest(client: httpx.AsyncClient, url: str) -> bool:
    try:
        resp = await client.get(url, headers=_REQUEST_HEADERS, follow_redirects=True)
    except Exception as exc:
        logger.warning("Manifest validation network failure: %s", exc)
        return False
    if resp.status_code != 200:
        logger.warning("Manifest validation failed status=%s url=%s", resp.status_code, url)
        return False
    text = (resp.text or "").strip()
    return "#EXTM3U" in text


async def fetch_fresh_stream_url(alias: str) -> str | None:
    token = _make_token()
    async with httpx.AsyncClient(timeout=15.0) as client:
        ts = int(time.time() * 1000)
        reg = await client.get(
            f"{IPCAM_API_BASE}/registerviewer.php",
            params={
                "_": ts,
                "alias": alias,
                "type": "HTML5",
                "browser": "Chrome Mobile",
                "browser_ver": "145.0.0.0",
                "os": "Android",
                "os_ver": "13",
                "streaming": "hls",
            },
            headers={**_REQUEST_HEADERS, "Referer": f"https://g3.ipcamlive.com/player/player.php?alias={alias}&autoplay=1"},
        )
        reg.raise_for_status()
        reg_data = reg.json()
        if reg_data.get("result") != "ok":
            logger.warning("registerviewer failed for alias=%s: %s", alias, reg_data)
            return None
        viewerid = reg_data.get("data", {}).get("viewerid")

        ts = int(time.time() * 1000)
        state = await client.get(
            f"{IPCAM_API_BASE}/getcamerastreamstate.php",
            params={
                "_": ts,
                "token": token,
                "alias": alias,
                "targetdomain": "g3.ipcamlive.com",
                "viewerid": viewerid,
            },
            headers={**_REQUEST_HEADERS, "Referer": f"https://g3.ipcamlive.com/player/player.php?alias={alias}&autoplay=1"},
        )
        state.raise_for_status()
        details = (state.json() or {}).get("details", {})
        url = _build_stream_url(details)
        if not url:
            return None
        if not await _validate_manifest(client, url):
            logger.warning("Discarded invalid manifest URL for alias=%s", alias)
            return None
        return url


async def fetch_youtube_stream_url(youtube_url: str) -> str | None:
    """
    Extract the HLS manifest URL from a YouTube live stream using yt-dlp.
    Returns None if the stream is offline or yt-dlp fails.
    YouTube HLS URLs are valid for ~6-8 h; refresh every 2 h via url_refresh_loop.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "yt-dlp",
            "--no-warnings",
            "--no-playlist",
            "-f", "best[protocol=m3u8_native][height<=720]/best[protocol=m3u8_native]/best",
            "--get-url",
            youtube_url,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=40.0)
        except asyncio.TimeoutError:
            proc.kill()
            logger.warning("yt-dlp timed out for %s", youtube_url)
            return None
        if proc.returncode != 0:
            logger.warning("yt-dlp exited %d for %s: %s", proc.returncode, youtube_url, stderr.decode().strip()[:200])
            return None
        hls_url = stdout.decode().strip().split("\n")[0]
        if hls_url.startswith("http"):
            logger.info("yt-dlp resolved HLS URL for %s", youtube_url)
            return hls_url
        logger.warning("yt-dlp returned non-URL output for %s: %s", youtube_url, hls_url[:100])
        return None
    except FileNotFoundError:
        logger.error("yt-dlp not found — install it via: pip install yt-dlp")
        return None
    except Exception as exc:
        logger.warning("fetch_youtube_stream_url error for %s: %s", youtube_url, exc)
        return None


async def _supabase_update_stream_url_by_id(camera_id: str, url: str) -> bool:
    """Update stream_url in Supabase by camera.id (used for YouTube cameras)."""
    from supabase_client import get_supabase
    try:
        sb = await get_supabase()
        await (
            sb.table("cameras")
            .update({"stream_url": url})
            .eq("id", camera_id)
            .execute()
        )
        return True
    except Exception as exc:
        logger.warning("Failed to persist stream URL for camera_id=%s: %s", camera_id, exc)
        return False


async def _get_candidate_cameras() -> list[dict]:
    """
    Return an ordered list of active camera dicts to try for stream URL resolution.
    Each dict has: type ("ipcam"|"youtube"), id, and either alias or youtube_url.
    Priority: is_active cameras from Supabase (newest first), then env var fallback.
    """
    from config import get_config
    cfg = get_config()
    out: list[dict] = []
    seen_ids: set[str] = set()

    try:
        from supabase_client import get_supabase
        sb = await get_supabase()
        resp = await (
            sb.table("cameras")
            .select("id,ipcam_alias,youtube_url,created_at")
            .eq("is_active", True)
            .order("created_at", desc=True)
            .execute()
        )
        for row in resp.data or []:
            cam_id = str(row.get("id") or "")
            if not cam_id or cam_id in seen_ids:
                continue
            seen_ids.add(cam_id)
            if row.get("youtube_url"):
                out.append({"type": "youtube", "id": cam_id, "youtube_url": row["youtube_url"]})
            elif row.get("ipcam_alias"):
                out.append({"type": "ipcam", "id": cam_id, "alias": row["ipcam_alias"]})
    except Exception as exc:
        logger.debug("Could not load cameras from DB: %s", exc)

    # Env var fallback (ipcam only)
    env_alias = str(cfg.CAMERA_ALIAS or "").strip()
    if env_alias and not any(c.get("alias") == env_alias for c in out):
        out.append({"type": "ipcam", "id": None, "alias": env_alias})

    return out


async def _supabase_update_stream_url(alias: str, url: str) -> bool:
    # Use the Supabase async SDK client — service role key stays off the wire
    from supabase_client import get_supabase
    try:
        sb = await get_supabase()
        await (
            sb.table("cameras")
            .update({"stream_url": url})
            .eq("ipcam_alias", alias)
            .execute()
        )
        return True
    except Exception as exc:
        logger.warning("Failed to persist stream URL for alias=%s: %s", alias, exc)
        return False


async def get_candidate_aliases(primary_alias: str | None = None) -> list[str]:
    """
    Build an ordered list of aliases to try for stream URL resolution.

    Priority:
      1. primary_alias (if given) — e.g. the alias explicitly requested
      2. The current is_active camera from Supabase (source of truth)
      3. CAMERA_ALIAS env var (static fallback)
      4. CAMERA_ALIASES env var list
    """
    from config import get_config
    cfg = get_config()
    out: list[str] = []

    def _push(v: str | None) -> None:
        s = str(v or "").strip()
        if s and s not in out:
            out.append(s)

    if primary_alias:
        _push(primary_alias)

    # Supabase is_active cameras are the authoritative source — put them first
    try:
        from supabase_client import get_supabase
        sb = await get_supabase()
        resp = await (
            sb.table("cameras")
            .select("ipcam_alias,created_at")
            .eq("is_active", True)
            .order("created_at", desc=True)
            .execute()
        )
        for row in resp.data or []:
            _push(row.get("ipcam_alias"))
    except Exception as exc:
        logger.debug("Could not load aliases from cameras table: %s", exc)

    # Env var aliases as fallback
    _push(cfg.CAMERA_ALIAS)
    for alias in getattr(cfg, "CAMERA_ALIASES", []) or []:
        _push(alias)

    return out


async def url_refresh_loop(alias: str, interval_seconds: int = 240) -> None:
    global _current_url, _current_alias, _yt_url_fetched_at
    event = _get_or_create_event()
    while True:
        try:
            # Always re-query Supabase so switching is_active is reflected
            # without a backend restart.
            cameras = await _get_candidate_cameras()
            if not cameras:
                cameras = [{"type": "ipcam", "id": None, "alias": alias}]

            selected_alias = None
            selected_url = None
            for cam in cameras:
                if cam["type"] == "ipcam":
                    url = await fetch_fresh_stream_url(cam["alias"])
                    if not url:
                        continue
                    selected_alias = cam["alias"]
                    selected_url = url
                    await _supabase_update_stream_url(cam["alias"], url)
                    break

                elif cam["type"] == "youtube":
                    yt_alias = f"yt:{cam['id']}"
                    url_age = time.time() - _yt_url_fetched_at
                    # Reuse cached URL if it's fresh (< 2h) and still for this camera
                    if _current_alias == yt_alias and _current_url and url_age < 7200:
                        selected_alias = yt_alias
                        selected_url = _current_url
                        logger.debug("YouTube URL cache hit for %s (age=%.0fs)", yt_alias, url_age)
                        break
                    url = await fetch_youtube_stream_url(cam["youtube_url"])
                    if not url:
                        continue
                    selected_alias = yt_alias
                    selected_url = url
                    _yt_url_fetched_at = time.time()
                    if cam["id"]:
                        await _supabase_update_stream_url_by_id(cam["id"], url)
                    break

            if selected_url and selected_alias:
                _current_url = selected_url
                _current_alias = selected_alias
                logger.info("URL refresh selected alias=%s", selected_alias)
            else:
                logger.warning("No online stream found in candidates=%s", cameras)
        except Exception as exc:
            logger.error("URL refresh error: %s", exc)

        # Wait for either the scheduled interval OR a forced-refresh signal.
        event.clear()
        try:
            await asyncio.wait_for(event.wait(), timeout=float(interval_seconds))
            logger.info("URL refresh: forced refresh triggered — running immediately")
        except asyncio.TimeoutError:
            pass


async def bulk_url_refresh_loop(interval_seconds: int = 21600) -> None:
    """
    Refresh stream URLs for ALL cameras in the DB on a long interval (default 6 h).

    This ensures every camera has a fresh stream_url in Supabase so that
    switching the active camera is instant — no on-demand fetch delay.
    Handles both ipcam and YouTube camera types.
    Runs once at startup (with a short delay to let the main refresh loop go
    first), then every `interval_seconds`.
    """
    await asyncio.sleep(30)   # let the main refresh loop claim the active URL first
    while True:
        try:
            from supabase_client import get_supabase
            sb = await get_supabase()
            resp = await (
                sb.table("cameras")
                .select("id,ipcam_alias,youtube_url")
                .order("is_active", desc=True)   # active camera first
                .execute()
            )
            cameras = resp.data or []
            logger.info("Bulk URL refresh starting for %d cameras", len(cameras))
            refreshed = 0
            for cam in cameras:
                try:
                    cam_id = cam.get("id")
                    if cam.get("youtube_url"):
                        url = await fetch_youtube_stream_url(cam["youtube_url"])
                        if url and cam_id:
                            await _supabase_update_stream_url_by_id(cam_id, url)
                            refreshed += 1
                    elif cam.get("ipcam_alias"):
                        url = await fetch_fresh_stream_url(cam["ipcam_alias"])
                        if url:
                            await _supabase_update_stream_url(cam["ipcam_alias"], url)
                            refreshed += 1
                    # Small gap between cameras — avoids hammering upstream APIs
                    await asyncio.sleep(5)
                except Exception as exc:
                    logger.warning("Bulk refresh failed for cam_id=%s: %s", cam.get("id"), exc)
            logger.info("Bulk URL refresh done: %d/%d cameras updated", refreshed, len(cameras))
        except Exception as exc:
            logger.error("Bulk URL refresh loop error: %s", exc)

        await asyncio.sleep(interval_seconds)
