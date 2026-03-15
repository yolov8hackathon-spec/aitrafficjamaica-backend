"""
auth_service.py — Validate Supabase JWTs via JWKS endpoint.
No shared secret required — we verify against Supabase's public keys.
"""
import logging
from typing import Any

import httpx
from jose import JWTError, jwt
from jose.exceptions import ExpiredSignatureError
from fastapi import HTTPException, status
from config import get_config

logger = logging.getLogger(__name__)

_jwks_cache: dict | None = None


async def _get_jwks() -> dict:
    """Fetch and cache JWKS from Supabase."""
    global _jwks_cache
    if _jwks_cache:
        return _jwks_cache
    cfg = get_config()
    url = f"{cfg.SUPABASE_URL}/auth/v1/.well-known/jwks.json"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        _jwks_cache = resp.json()
        logger.info("JWKS fetched from Supabase")
    return _jwks_cache


async def validate_supabase_jwt(token: str) -> dict[str, Any]:
    """
    Validate a Supabase JWT.
    Returns the decoded payload (sub = user_id, app_metadata, etc.).
    Raises HTTPException 401 on any failure.
    """
    try:
        jwks = await _get_jwks()
        # jose can verify against a JWKS dict directly
        payload = jwt.decode(
            token,
            jwks,
            algorithms=["RS256", "HS256"],
            options={"verify_aud": False},
        )
        return payload
    except ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired")
    except JWTError as exc:
        logger.warning("JWT validation failed: %s", exc)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")


def require_admin(payload: dict[str, Any]) -> None:
    """Raise 403 if the JWT payload does not carry admin role."""
    role = (payload.get("app_metadata") or {}).get("role")
    if role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin required")


def get_user_id(payload: dict[str, Any]) -> str:
    """Extract user UUID string from JWT payload."""
    uid = payload.get("sub")
    if not uid:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No sub in token")
    return uid
