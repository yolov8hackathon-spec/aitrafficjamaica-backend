"""
services/leaderboard_service.py — Pre-aggregated leaderboard cache.

Replaces heavy per-client Supabase queries with a single backend aggregation
that runs every _REFRESH_INTERVAL seconds and caches results in memory.

Windows: 60s / 180s / 300s (matching frontend 1MIN / 3MIN / 5MIN tabs).

Exposed API:
    get_leaderboard(window_sec)  → cached list of ranked rows
    refresh_all()                → force immediate refresh of all windows
    leaderboard_refresh_loop()   → async background task for lifespan
"""
import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

_REFRESH_INTERVAL = 60       # seconds between full refreshes
_STARTUP_DELAY    = 20       # wait before first aggregation (let DB settle)
_WINDOWS          = (60, 180, 300)
_TOP_N            = 50       # rows per window

# In-memory cache: window_sec → {"rows": [...], "refreshed_at": ISO}
_cache: dict[int, dict[str, Any]] = {w: {"rows": [], "refreshed_at": None} for w in _WINDOWS}


def get_leaderboard(window_sec: int) -> dict[str, Any]:
    """Return cached leaderboard for the given window (60, 180, or 300)."""
    return _cache.get(window_sec, {"rows": [], "refreshed_at": None})


async def refresh_window(window_sec: int) -> None:
    """Aggregate bets for one window and update the in-memory cache."""
    from supabase_client import get_supabase
    try:
        sb = await get_supabase()

        resp = await (
            sb.table("bets")
            .select("user_id, status, amount, potential_payout, window_duration_sec")
            .eq("window_duration_sec", window_sec)
            .in_("status", ["won", "lost", "pending"])
            .limit(50000)
            .execute()
        )
        rows = resp.data or []

        # Aggregate per user
        agg: dict[str, dict[str, Any]] = {}
        for r in rows:
            uid = r.get("user_id")
            if not uid:
                continue
            if uid not in agg:
                agg[uid] = {"user_id": uid, "wins": 0, "losses": 0, "pending": 0,
                            "total_pts": 0, "total_staked": 0}
            status = r.get("status")
            amount = int(r.get("amount") or 0)
            payout = int(r.get("potential_payout") or 0)
            agg[uid]["total_staked"] += amount
            if status == "won":
                agg[uid]["wins"] += 1
                agg[uid]["total_pts"] += payout
            elif status == "lost":
                agg[uid]["losses"] += 1
            elif status == "pending":
                agg[uid]["pending"] += 1

        ranked = sorted(agg.values(), key=lambda x: x["total_pts"], reverse=True)
        for i, row in enumerate(ranked[:_TOP_N], start=1):
            row["rank"] = i

        _cache[window_sec] = {
            "rows": ranked[:_TOP_N],
            "refreshed_at": datetime.now(timezone.utc).isoformat(),
        }
        logger.debug("Leaderboard refreshed window=%ds rows=%d", window_sec, len(ranked))
    except Exception as exc:
        logger.warning("Leaderboard refresh failed window=%ds: %s", window_sec, exc)


async def refresh_all() -> None:
    """Force refresh all windows concurrently."""
    await asyncio.gather(*[refresh_window(w) for w in _WINDOWS], return_exceptions=True)


async def leaderboard_refresh_loop(interval_sec: int = _REFRESH_INTERVAL) -> None:
    """
    Background task: refresh all leaderboard windows every interval_sec.
    Wire into lifespan startup.
    """
    await asyncio.sleep(_STARTUP_DELAY)
    while True:
        await refresh_all()
        await asyncio.sleep(interval_sec)
