"""
ws_manager.py — Connection manager for public and per-user WebSocket connections.
"""
import asyncio
import json
import logging
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


MAX_CONNECTIONS_PER_USER = 4    # prevents single JWT from exhausting sockets
MAX_PUBLIC_CONNECTIONS   = 2000  # hard cap on unauthenticated public connections


class ConnectionManager:
    """
    Manages:
    - A set of public connections (subscribing to live count + market data)
    - A dict of per-user connections (subscribing to personal events)
    """

    def __init__(self):
        self._public: set[WebSocket] = set()
        self._user_connections: dict[str, set[WebSocket]] = defaultdict(set)
        self._public_meta: dict[int, dict[str, Any]] = {}
        self._user_socket_meta: dict[int, dict[str, Any]] = {}
        self._public_connection_events: int = 0
        self._user_connection_events: int = 0
        self._event_log: deque[dict[str, Any]] = deque(maxlen=500)
        self._started_at = datetime.now(timezone.utc).isoformat()

    # ── Public channel ─────────────────────────────────────────────────────

    def _event_time(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _log_event(self, event: str, channel: str, **fields: Any) -> None:
        self._event_log.append(
            {
                "at": self._event_time(),
                "event": event,
                "channel": channel,
                **fields,
            }
        )

    async def connect_public(self, ws: WebSocket, meta: dict[str, Any] | None = None) -> None:
        if len(self._public) >= MAX_PUBLIC_CONNECTIONS:
            await ws.close(code=4029, reason="Server at capacity")
            return
        await ws.accept()
        self._public.add(ws)
        self._public_connection_events += 1
        ws_id = id(ws)
        normalized_meta = {
            "connected_at": self._event_time(),
            "origin": (meta or {}).get("origin"),
            "ip": (meta or {}).get("ip"),
            "user_agent": (meta or {}).get("user_agent"),
        }
        self._public_meta[ws_id] = normalized_meta
        self._log_event("connect", "public", socket_id=ws_id, **normalized_meta)
        logger.debug("Public WS connected. Total: %d", len(self._public))

    def disconnect_public(self, ws: WebSocket) -> None:
        self._public.discard(ws)
        ws_id = id(ws)
        meta = self._public_meta.pop(ws_id, {})
        self._log_event("disconnect", "public", socket_id=ws_id, **meta)
        logger.debug("Public WS disconnected. Total: %d", len(self._public))

    async def broadcast_public(self, data: dict[str, Any]) -> None:
        """Send JSON data to all public subscribers."""
        payload = json.dumps(data)
        targets = list(self._public)
        if not targets:
            return

        async def _safe_send(ws: WebSocket) -> tuple[WebSocket, bool]:
            try:
                # Prevent one slow socket from stalling the whole broadcast.
                await asyncio.wait_for(ws.send_text(payload), timeout=0.75)
                return ws, True
            except Exception:
                return ws, False

        results = await asyncio.gather(*(_safe_send(ws) for ws in targets), return_exceptions=False)
        for ws, ok in results:
            if not ok:
                self._public.discard(ws)

    # ── User channel ───────────────────────────────────────────────────────

    def user_socket_count_for(self, user_id: str) -> int:
        return len(self._user_connections.get(user_id, set()))

    async def connect_user(self, ws: WebSocket, user_id: str, meta: dict[str, Any] | None = None) -> None:
        if self.user_socket_count_for(user_id) >= MAX_CONNECTIONS_PER_USER:
            await ws.close(code=4029, reason="Connection limit exceeded")
            return
        await ws.accept()
        self._user_connections[user_id].add(ws)
        self._user_connection_events += 1
        ws_id = id(ws)
        normalized_meta = {
            "connected_at": self._event_time(),
            "user_id": user_id,
            "origin": (meta or {}).get("origin"),
            "ip": (meta or {}).get("ip"),
            "user_agent": (meta or {}).get("user_agent"),
        }
        self._user_socket_meta[ws_id] = normalized_meta
        self._log_event("connect", "account", socket_id=ws_id, **normalized_meta)
        logger.debug("User %s WS connected. Sockets: %d", user_id, len(self._user_connections[user_id]))

    def disconnect_user(self, ws: WebSocket, user_id: str) -> None:
        self._user_connections[user_id].discard(ws)
        ws_id = id(ws)
        meta = self._user_socket_meta.pop(ws_id, {"user_id": user_id})
        self._log_event("disconnect", "account", socket_id=ws_id, **meta)
        if not self._user_connections[user_id]:
            del self._user_connections[user_id]
        logger.debug("User %s WS disconnected", user_id)

    async def send_to_user(self, user_id: str, data: dict[str, Any]) -> None:
        """Send JSON data to a specific user's connections."""
        sockets = self._user_connections.get(user_id, set())
        payload = json.dumps(data)
        targets = list(sockets)
        if not targets:
            return

        async def _safe_send(ws: WebSocket) -> tuple[WebSocket, bool]:
            try:
                await asyncio.wait_for(ws.send_text(payload), timeout=0.75)
                return ws, True
            except Exception:
                return ws, False

        results = await asyncio.gather(*(_safe_send(ws) for ws in targets), return_exceptions=False)
        for ws, ok in results:
            if not ok:
                self._user_connections[user_id].discard(ws)

    @property
    def public_count(self) -> int:
        return len(self._public)

    @property
    def user_count(self) -> int:
        return len(self._user_connections)

    @property
    def user_socket_count(self) -> int:
        return sum(len(sockets) for sockets in self._user_connections.values())

    @property
    def public_connection_events(self) -> int:
        return self._public_connection_events

    @property
    def user_connection_events(self) -> int:
        return self._user_connection_events

    def connection_snapshot(self) -> dict[str, Any]:
        public_clients = []
        for meta in self._public_meta.values():
            public_clients.append(
                {
                    "connected_at": meta.get("connected_at"),
                    "ip": meta.get("ip"),
                    "origin": meta.get("origin"),
                    "user_agent": meta.get("user_agent"),
                }
            )
        public_clients.sort(key=lambda item: str(item.get("connected_at") or ""), reverse=True)

        authenticated_users = []
        for user_id, sockets in self._user_connections.items():
            connected_at = []
            ips = set()
            for ws in sockets:
                meta = self._user_socket_meta.get(id(ws), {})
                if meta.get("connected_at"):
                    connected_at.append(str(meta["connected_at"]))
                if meta.get("ip"):
                    ips.add(str(meta["ip"]))
            authenticated_users.append(
                {
                    "user_id": user_id,
                    "socket_count": len(sockets),
                    "first_connected_at": min(connected_at) if connected_at else None,
                    "last_connected_at": max(connected_at) if connected_at else None,
                    "ips": sorted(ips),
                }
            )
        authenticated_users.sort(key=lambda item: str(item.get("last_connected_at") or ""), reverse=True)

        return {
            "started_at": self._started_at,
            "online_now": {
                "public_ws_connections": self.public_count,
                "account_ws_users": self.user_count,
                "account_ws_sockets": self.user_socket_count,
                "total_ws_connections": self.public_count + self.user_socket_count,
            },
            "visit_totals": {
                "public_ws_connections_total": self.public_connection_events,
                "account_ws_connections_total": self.user_connection_events,
                "combined_ws_connections_total": self.public_connection_events + self.user_connection_events,
            },
            "active_public_clients": public_clients,
            "active_authenticated_users": authenticated_users,
            "recent_events": list(self._event_log),
        }


# Singleton
manager = ConnectionManager()
