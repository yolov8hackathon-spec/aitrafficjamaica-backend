"""
hmac_auth.py — HMAC-SHA256 token validation for the public /ws/live endpoint.
Tokens are issued server-side by Vercel /api/token and expire after 5 minutes.

Token format (v2): '<timestamp>.<nonce>.<hmac_hex>'
  - timestamp: Unix seconds (int)
  - nonce: 16-char hex random (8 bytes) — prevents same-second token collision
  - hmac_hex: HMAC-SHA256(secret, f"{timestamp}.{nonce}.{extra}")

Replay protection: used signatures are tracked in a TTL'd in-memory set.
Nonce tracking automatically purges entries older than TOKEN_TTL_SECONDS * 2.
"""
import hashlib
import hmac
import secrets
import time
import logging
from typing import Optional

logger = logging.getLogger(__name__)

TOKEN_TTL_SECONDS = 300   # 5 minutes
_NONCE_TTL        = TOKEN_TTL_SECONDS * 2   # keep seen nonces for 2× TTL

# Replay protection: maps nonce → expiry_monotonic
_seen_nonces: dict[str, float] = {}


def _purge_expired_nonces() -> None:
    """Evict nonces whose token could no longer be valid."""
    now = time.monotonic()
    expired = [k for k, exp in _seen_nonces.items() if now > exp]
    for k in expired:
        del _seen_nonces[k]


def generate_ws_token(secret: str, extra: str = "") -> str:
    """
    Generate a HMAC token: '<timestamp>.<nonce>.<hmac_hex>'
    'extra' can be any additional binding string (e.g. client IP).
    """
    ts    = str(int(time.time()))
    nonce = secrets.token_hex(8)          # 16 hex chars — unique per call
    payload = f"{ts}.{nonce}.{extra}"
    sig = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{ts}.{nonce}.{sig}"


def validate_ws_token(token: Optional[str], secret: str, extra: str = "", check_nonce: bool = True) -> bool:
    """
    Validate a HMAC WS token (v2 format: ts.nonce.sig).
    Returns True if signature is valid, token is within TTL, and nonce not replayed.
    Set check_nonce=False for HTTP endpoints (stream manifest/segments) where
    HLS.js may retry the same token — nonce replay protection is only needed for WS.
    """
    if not token:
        return False

    try:
        parts = token.split(".", 2)
        if len(parts) != 3:
            logger.warning("WS token malformed (expected 3 parts, got %d)", len(parts))
            return False
        ts_str, nonce, provided_sig = parts
        ts = int(ts_str)
    except (ValueError, AttributeError):
        logger.warning("WS token parse error")
        return False

    age = int(time.time()) - ts
    if age < 0 or age > TOKEN_TTL_SECONDS:
        logger.warning("WS token expired (age=%ds)", age)
        return False

    payload  = f"{ts_str}.{nonce}.{extra}"
    expected = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, provided_sig):
        logger.warning("WS token signature mismatch")
        return False

    # ── Replay protection (WS only) ──────────────────────────────
    if check_nonce:
        _purge_expired_nonces()
        if nonce in _seen_nonces:
            logger.warning("WS token replay detected (nonce=%s)", nonce[:8])
            return False
        _seen_nonces[nonce] = time.monotonic() + _NONCE_TTL

    return True
