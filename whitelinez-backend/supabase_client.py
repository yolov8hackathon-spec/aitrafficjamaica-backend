"""
supabase_client.py — Async Supabase client using the service role key.
Used for all server-side DB operations (bypasses RLS when needed).
"""
import logging
from functools import lru_cache

from supabase import AsyncClient, acreate_client
from config import get_config

logger = logging.getLogger(__name__)

_client: AsyncClient | None = None


async def get_supabase() -> AsyncClient:
    """Return (and lazily init) the shared async Supabase service-role client."""
    global _client
    if _client is None:
        cfg = get_config()
        _client = await acreate_client(
            cfg.SUPABASE_URL,
            cfg.SUPABASE_SERVICE_ROLE_KEY,
        )
        logger.info("Supabase async client initialised (service role)")
    return _client


async def close_supabase() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
        logger.info("Supabase client closed")
