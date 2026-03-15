"""
routers/stream.py - GET /stream/live.m3u8 + GET /stream/ts
Validates HMAC token, reads the current HLS URL from Supabase, proxies the
manifest, and rewrites all segment URLs through a server-side proxy so the
upstream camera CDN URL is never visible in the browser.
"""
import asyncio
import base64
import logging
import time
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from ai.url_refresher import (
    _supabase_update_stream_url,
    _supabase_update_stream_url_by_id,
    fetch_fresh_stream_url,
    fetch_youtube_stream_url,
    get_candidate_aliases,
    get_current_alias,
    get_current_url,
)
from config import get_config
from middleware.hmac_auth import validate_ws_token
from supabase_client import get_supabase

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/stream", tags=["stream"])

_CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Range",
    "Access-Control-Max-Age":       "86400",
}

_PROXY_HEADERS = {
    "Referer": "https://www.ipcamlive.com/",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
}

# Short in-process cache to reduce load when many clients request the same
# manifest at the same time.  Both caches are alias-aware so switching the
# active camera on the frontend immediately serves the correct stream.
_MANIFEST_CACHE_TTL_SEC = 1.25
_STREAM_URL_CACHE_TTL_SEC = 8.0
_cache_lock = asyncio.Lock()
_manifest_cache: dict[str, object] = {"body": "", "fetched_at": 0.0, "alias": ""}
_stream_url_cache: dict[str, object] = {"url": "", "fetched_at": 0.0, "alias": ""}


async def _get_stream_url(cfg, preferred_alias: str | None = None) -> str:
    now = time.monotonic()
    cached_url = str(_stream_url_cache.get("url") or "")
    cached_at = float(_stream_url_cache.get("fetched_at") or 0.0)
    cached_alias = str(_stream_url_cache.get("alias") or "")

    # Cache hit only valid when the alias matches (or no alias was requested).
    alias_match = not preferred_alias or preferred_alias == cached_alias
    if cached_url and alias_match and (now - cached_at) < _STREAM_URL_CACHE_TTL_SEC:
        return cached_url

    # Use the refresher's live-selected URL only if it matches the requested alias.
    live_url = str(get_current_url() or "").strip()
    live_alias = str(get_current_alias() or "").strip()
    if live_url and (not preferred_alias or preferred_alias == live_alias):
        _stream_url_cache["url"] = live_url
        _stream_url_cache["alias"] = live_alias
        _stream_url_cache["fetched_at"] = now
        return live_url

    # ── YouTube camera lookup by camera ID (alias="yt:<uuid>") ──────────────
    # Non-AI YouTube cameras send alias="yt:<camera_id>" from the frontend.
    # Their HLS URL is stored in cameras.stream_url by camera id (not ipcam_alias).
    # Handle this before the ipcam alias loop so we don't fall through to the AI cam.
    if preferred_alias and preferred_alias.startswith("yt:"):
        cam_id = preferred_alias[3:]
        try:
            supabase = await get_supabase()
            cam_resp = await (
                supabase.table("cameras")
                .select("stream_url,youtube_url")
                .eq("id", cam_id)
                .limit(1)
                .execute()
            )
            cam_data = (cam_resp.data or [{}])[0]
            cached_yt_url = str(cam_data.get("stream_url") or "").strip()
            if cached_yt_url:
                _stream_url_cache["url"] = cached_yt_url
                _stream_url_cache["alias"] = preferred_alias
                _stream_url_cache["fetched_at"] = now
                return cached_yt_url
            elif cam_data.get("youtube_url"):
                # No cached URL — fetch via yt-dlp on-demand
                logger.info("No cached stream URL for yt camera %s — fetching via yt-dlp", cam_id)
                fresh = await fetch_youtube_stream_url(cam_data["youtube_url"])
                if fresh:
                    _stream_url_cache["url"] = fresh
                    _stream_url_cache["alias"] = preferred_alias
                    _stream_url_cache["fetched_at"] = now
                    await _supabase_update_stream_url_by_id(cam_id, fresh)
                    return fresh
        except Exception as exc:
            logger.error("YouTube camera lookup failed for id=%s: %s", cam_id, exc)
        raise HTTPException(status_code=503, detail="YouTube stream not yet available")

    # Fall back to DB lookup for ipcam aliases.
    try:
        supabase = await get_supabase()
        aliases = await get_candidate_aliases(preferred_alias or cfg.CAMERA_ALIAS)
        stream_url = ""
        resolved_alias = ""
        for alias in aliases:
            cam = await (
                supabase.table("cameras")
                .select("stream_url")
                .eq("ipcam_alias", alias)
                .limit(1)
                .execute()
            )
            candidate = str((cam.data or [{}])[0].get("stream_url") or "").strip()
            if candidate:
                stream_url = candidate
                resolved_alias = alias
                break
    except Exception as exc:
        logger.error("DB lookup failed in _get_stream_url: %s", exc)
        aliases = [preferred_alias or cfg.CAMERA_ALIAS]
        stream_url = ""
        resolved_alias = ""

    # If DB has no URL (null or table error), fetch one on-demand.
    # This handles: newly switched camera, stream rotation, first boot.
    if not stream_url:
        logger.info("No cached stream URL — fetching on-demand for aliases=%s", aliases[:3])
        for alias in aliases[:3]:
            try:
                fresh = await fetch_fresh_stream_url(alias)
            except Exception as exc:
                logger.warning("on-demand fetch failed for alias=%s: %s", alias, exc)
                fresh = None
            if fresh:
                stream_url = fresh
                resolved_alias = alias
                await _supabase_update_stream_url(alias, fresh)
                break

    # Last resort: use whatever the background refresh loop has, even if the
    # alias doesn't match.  The AI is already reading from this URL successfully.
    if not stream_url:
        fallback_url = str(get_current_url() or "").strip()
        if fallback_url:
            logger.warning(
                "Stream URL unavailable for alias=%s — falling back to refresh-loop URL",
                preferred_alias,
            )
            stream_url = fallback_url
            resolved_alias = str(get_current_alias() or "")

    if not stream_url:
        raise HTTPException(status_code=503, detail="Stream URL not yet available")

    _stream_url_cache["url"] = stream_url
    _stream_url_cache["alias"] = resolved_alias
    _stream_url_cache["fetched_at"] = now
    return stream_url


def _rewrite_manifest(manifest_body: str, base_url: str, segment_proxy_base: str = "") -> str:
    """
    Rewrite all non-comment/non-tag lines in an HLS manifest.

    When *segment_proxy_base* is set every segment/playlist line is replaced by:
        {segment_proxy_base}?p=<base64url(original_absolute_url)>
    so the browser never sees the upstream camera CDN domain.

    Without segment_proxy_base, relative lines are resolved to absolute URLs
    (original fall-back behaviour).
    """
    lines = []
    for line in manifest_body.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            if segment_proxy_base:
                # Resolve relative paths to absolute, then encode the full URL.
                full_url = stripped if stripped.startswith("http") else urljoin(base_url, stripped)
                encoded = base64.urlsafe_b64encode(full_url.encode()).rstrip(b"=").decode()
                line = f"{segment_proxy_base}?p={encoded}"
            elif not stripped.startswith("http"):
                line = urljoin(base_url, stripped)
        lines.append(line)
    return "\n".join(lines)


@router.options("/live.m3u8")
async def stream_manifest_preflight():
    return Response(None, status_code=204, headers=_CORS_HEADERS)


@router.get("/live.m3u8")
async def stream_manifest(
    token: str = Query(...),
    alias: str | None = Query(default=None),
):
    cfg = get_config()
    if not validate_ws_token(token, cfg.WS_AUTH_SECRET, check_nonce=False):
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    preferred_alias = str(alias or "").strip() or None

    now = time.monotonic()
    cached_body = str(_manifest_cache.get("body") or "")
    cached_at = float(_manifest_cache.get("fetched_at") or 0.0)
    cached_alias = str(_manifest_cache.get("alias") or "")
    alias_match = not preferred_alias or preferred_alias == cached_alias
    if cached_body and alias_match and (now - cached_at) < _MANIFEST_CACHE_TTL_SEC:
        return Response(
            content=cached_body,
            media_type="application/vnd.apple.mpegurl",
            headers={"Cache-Control": "no-cache, no-store", **_CORS_HEADERS},
        )

    async with _cache_lock:
        now = time.monotonic()
        cached_body = str(_manifest_cache.get("body") or "")
        cached_at = float(_manifest_cache.get("fetched_at") or 0.0)
        cached_alias = str(_manifest_cache.get("alias") or "")
        alias_match = not preferred_alias or preferred_alias == cached_alias
        if cached_body and alias_match and (now - cached_at) < _MANIFEST_CACHE_TTL_SEC:
            return Response(
                content=cached_body,
                media_type="application/vnd.apple.mpegurl",
                headers={"Cache-Control": "no-cache, no-store", **_CORS_HEADERS},
            )

        try:
            stream_url = await _get_stream_url(cfg, preferred_alias=preferred_alias)
        except HTTPException:
            raise
        except Exception as exc:
            logger.error("Unexpected error resolving stream URL: %s", exc)
            raise HTTPException(status_code=503, detail="Stream URL not yet available")

        base_url = stream_url.rsplit("/", 1)[0] + "/"

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    stream_url,
                    headers=_PROXY_HEADERS,
                    follow_redirects=True,
                )
                # If the persisted URL is stale, force one refresh and retry.
                if resp.status_code == 404:
                    logger.warning("Stored HLS URL returned 404, attempting one forced refresh")
                    fallback_aliases = await get_candidate_aliases(preferred_alias or cfg.CAMERA_ALIAS)
                    for fa in fallback_aliases:
                        fresh = await fetch_fresh_stream_url(fa)
                        if not fresh:
                            continue
                        stream_url = fresh
                        base_url = stream_url.rsplit("/", 1)[0] + "/"
                        _stream_url_cache["url"] = stream_url
                        _stream_url_cache["alias"] = fa
                        _stream_url_cache["fetched_at"] = time.monotonic()
                        await _supabase_update_stream_url(fa, fresh)
                        resp = await client.get(
                            stream_url,
                            headers=_PROXY_HEADERS,
                            follow_redirects=True,
                        )
                        if resp.status_code == 200:
                            break
        except Exception as exc:
            logger.error("Failed to fetch HLS manifest: %s", exc)
            raise HTTPException(status_code=502, detail="Stream unavailable")

        if resp.status_code != 200:
            logger.warning("HLS manifest returned %d for URL: %s", resp.status_code, stream_url)
            raise HTTPException(status_code=502, detail="Stream unavailable")

        segment_proxy_base = (
            f"{cfg.FRONTEND_URL}/stream/ts" if cfg.FRONTEND_URL else ""
        )
        rewritten = _rewrite_manifest(resp.text, base_url, segment_proxy_base=segment_proxy_base)
        _manifest_cache["body"] = rewritten
        _manifest_cache["alias"] = preferred_alias or ""
        _manifest_cache["fetched_at"] = time.monotonic()

    return Response(
        content=rewritten,
        media_type="application/vnd.apple.mpegurl",
        headers={"Cache-Control": "no-cache, no-store", **_CORS_HEADERS},
    )


# ── Segment proxy ────────────────────────────────────────────────────────────

# Only proxy requests to known camera CDN domains — prevents open-proxy abuse.
_ALLOWED_SEGMENT_SUFFIXES = (".ipcamlive.com", ".googlevideo.com")


@router.get("/ts")
async def stream_segment(p: str = Query(..., max_length=4096)):
    """
    Proxy a single HLS transport-stream (*.ts) or sub-playlist (*.m3u8) segment.

    *p* is a base64url-encoded upstream segment URL produced by _rewrite_manifest.
    The actual CDN URL is never sent to the browser.

    If the proxied content is an m3u8 sub-playlist (YouTube quality-level manifests),
    its segment URLs are also rewritten through the proxy so the browser never
    sees raw googlevideo.com URLs (which have no CORS headers).
    """
    # Decode the opaque segment reference
    try:
        padded = p + "=" * (-len(p) % 4)
        segment_url = base64.urlsafe_b64decode(padded).decode()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid segment reference")

    parsed = urlparse(segment_url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Invalid segment scheme")

    # Guard against open-proxy abuse: only allow known camera CDN hosts
    if not any(parsed.netloc.endswith(s) for s in _ALLOWED_SEGMENT_SUFFIXES):
        logger.warning("Segment proxy blocked non-allowed host: %s", parsed.netloc)
        raise HTTPException(status_code=400, detail="Segment origin not allowed")

    is_m3u8 = segment_url.endswith(".m3u8") or "m3u8" in segment_url.lower().split("?")[0][-10:]

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                segment_url,
                headers=_PROXY_HEADERS,
                follow_redirects=True,
            )
            if resp.status_code != 200:
                raise HTTPException(status_code=502, detail="Segment unavailable")

            # If this is an m3u8 sub-playlist, rewrite its segment URLs through
            # the proxy so the browser never receives raw googlevideo.com URLs.
            if is_m3u8 or "mpegurl" in (resp.headers.get("content-type") or ""):
                cfg = get_config()
                base_url = segment_url.rsplit("/", 1)[0] + "/"
                segment_proxy_base = (
                    f"{cfg.FRONTEND_URL}/api/stream" if cfg.FRONTEND_URL else ""
                )
                rewritten = _rewrite_manifest(resp.text, base_url, segment_proxy_base=segment_proxy_base)
                return Response(
                    content=rewritten,
                    media_type="application/vnd.apple.mpegurl",
                    headers={"Cache-Control": "no-cache, no-store", **_CORS_HEADERS},
                )

            return Response(
                content=resp.content,
                media_type="video/MP2T",
                headers={"Cache-Control": "public, max-age=10", **_CORS_HEADERS},
            )
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Segment proxy error: %s", exc)
        raise HTTPException(status_code=502, detail="Segment unavailable")
