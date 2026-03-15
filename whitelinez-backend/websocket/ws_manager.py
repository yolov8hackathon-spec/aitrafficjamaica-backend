"""
ws_manager.py — Connection manager for public and per-user WebSocket connections.
"""
import asyncio
import json
import logging
from collections import defaultdict
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    """
    Manages:
    - A set of public connections (subscribing to live count + market data)
    - A dict of per-user connections (subscribing to personal events)
    """

    def __init__(self):
        self._public: set[WebSocket] = set()
        self._user_connections: dict[str, set[WebSocket]] = defaultdict(set)

    # ── Public channel ─────────────────────────────────────────────────────

    async def connect_public(self, ws: WebSocket) -> None:
        await ws.accept()
        self._public.add(ws)
        logger.debug("Public WS connected. Total: %d", len(self._public))

    def disconnect_public(self, ws: WebSocket) -> None:
        self._public.discard(ws)
        logger.debug("Public WS disconnected. Total: %d", len(self._public))

    async def broadcast_public(self, data: dict[str, Any]) -> None:
        """Send JSON data to all public subscribers."""
        dead: list[WebSocket] = []
        payload = json.dumps(data)
        for ws in list(self._public):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._public.discard(ws)

    # ── User channel ───────────────────────────────────────────────────────

    async def connect_user(self, ws: WebSocket, user_id: str) -> None:
        await ws.accept()
        self._user_connections[user_id].add(ws)
        logger.debug("User %s WS connected. Sockets: %d", user_id, len(self._user_connections[user_id]))

    def disconnect_user(self, ws: WebSocket, user_id: str) -> None:
        self._user_connections[user_id].discard(ws)
        if not self._user_connections[user_id]:
            del self._user_connections[user_id]
        logger.debug("User %s WS disconnected", user_id)

    async def send_to_user(self, user_id: str, data: dict[str, Any]) -> None:
        """Send JSON data to a specific user's connections."""
        sockets = self._user_connections.get(user_id, set())
        dead: list[WebSocket] = []
        payload = json.dumps(data)
        for ws in list(sockets):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._user_connections[user_id].discard(ws)

    @property
    def public_count(self) -> int:
        return len(self._public)

    @property
    def user_count(self) -> int:
        return len(self._user_connections)


# Singleton
manager = ConnectionManager()
