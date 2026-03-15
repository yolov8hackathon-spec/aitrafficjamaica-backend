"""
hmac_auth.py — HMAC-SHA256 token validation for the public /ws/live endpoint.
Tokens are issued server-side by Vercel /api/token and expire after 5 minutes.
"""
import hashlib
import hmac
import time
import logging
from typing import Optional

logger = logging.getLogger(__name__)

TOKEN_TTL_SECONDS = 300  # 5 minutes


def generate_ws_token(secret: str, extra: str = "") -> str:
    """
    Generate a HMAC token: '<timestamp>.<hmac_hex>'
    'extra' can be any additional binding string (e.g. client IP).
    """
    ts = str(int(time.time()))
    payload = f"{ts}.{extra}"
    sig = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{ts}.{sig}"


def validate_ws_token(token: Optional[str], secret: str, extra: str = "") -> bool:
    """
    Validate a HMAC WS token.
    Returns True if valid and not expired.
    """
    if not token:
        return False
    try:
        ts_str, provided_sig = token.split(".", 1)
        ts = int(ts_str)
    except (ValueError, AttributeError):
        logger.warning("WS token malformed")
        return False

    age = int(time.time()) - ts
    if age < 0 or age > TOKEN_TTL_SECONDS:
        logger.warning("WS token expired (age=%ds)", age)
        return False

    payload = f"{ts_str}.{extra}"
    expected_sig = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(expected_sig, provided_sig):
        logger.warning("WS token signature mismatch")
        return False

    return True
