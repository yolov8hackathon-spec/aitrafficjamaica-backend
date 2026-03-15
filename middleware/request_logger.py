"""
middleware/request_logger.py — Structured request/response logging middleware.

Logs every HTTP request with method, path, status code, and response time
as structured JSON to stdout. Integrates with Railway's log drain.

Skips logging for:
  - Static file paths (/static/, /assets/)
  - Health-check ping endpoints (/api/ping, /healthz)
  - WebSocket upgrade requests (logged separately by WS handlers)

Usage in main.py:
    from middleware.request_logger import RequestLoggerMiddleware
    app.add_middleware(RequestLoggerMiddleware)
"""
import json
import logging
import time
from typing import Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger("request")

_SKIP_PREFIXES = ("/static/", "/assets/", "/favicon")
_SKIP_EXACT    = {"/api/ping", "/healthz", "/health"}


def _should_skip(path: str) -> bool:
    if path in _SKIP_EXACT:
        return True
    return any(path.startswith(p) for p in _SKIP_PREFIXES)


class RequestLoggerMiddleware(BaseHTTPMiddleware):
    """
    ASGI middleware that emits one structured log line per HTTP request.

    Log fields:
        method, path, status, duration_ms, ip, user_agent
    """

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        path = request.url.path

        # Pass through WebSocket upgrades untouched
        if request.headers.get("upgrade", "").lower() == "websocket":
            return await call_next(request)

        if _should_skip(path):
            return await call_next(request)

        start = time.perf_counter()
        status_code = 500

        try:
            response: Response = await call_next(request)
            status_code = response.status_code
            return response
        except Exception as exc:
            raise exc
        finally:
            duration_ms = round((time.perf_counter() - start) * 1000, 1)
            ip = (
                request.headers.get("x-forwarded-for", "").split(",")[0].strip()
                or request.headers.get("x-real-ip", "")
                or (request.client.host if request.client else "")
            )
            log_record = {
                "method":      request.method,
                "path":        path,
                "status":      status_code,
                "duration_ms": duration_ms,
                "ip":          ip,
                "ua":          request.headers.get("user-agent", "")[:120],
            }
            # Use WARNING for 5xx, INFO for the rest so Railway log filters work
            level = logging.WARNING if status_code >= 500 else logging.INFO
            logger.log(level, json.dumps(log_record))
