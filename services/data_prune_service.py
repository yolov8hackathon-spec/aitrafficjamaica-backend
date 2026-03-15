"""
services/data_prune_service.py — Periodic pruning of high-volume tables.

Runs every hour automatically.

Retention policy:
    ml_detection_events   — 2 hours   (writes ~15 rows/sec; keeps ~108K rows max)
    count_snapshots       — 6 hours   (writes ~1 row/sec;  keeps ~21.6K rows max)
    vehicle_crossings     — 7 days    (per-vehicle events; ~4K rows/day x 7d = ~28K rows; enables week exports)
    turning_movements     — 7 days    (exit completions; 30K rows/day x 7d = 210K rows = ~50 MB; needed for outbound analytics)
    traffic_snapshots     — 3 days    (used by analytics API)
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

_PRUNE_INTERVAL_SEC = 3600        # every 1 hour
_STARTUP_DELAY_SEC  = 60          # wait 60s after boot before first run

_POLICY: list[tuple[str, str, timedelta]] = [
    ("ml_detection_events", "captured_at", timedelta(hours=2)),
    ("count_snapshots",     "captured_at", timedelta(hours=6)),
    ("vehicle_crossings",   "captured_at", timedelta(days=7)),
    ("turning_movements",   "captured_at", timedelta(days=7)),
    ("traffic_snapshots",   "captured_at", timedelta(days=3)),
]


async def _prune_table(sb, table: str, ts_col: str, cutoff_iso: str) -> int:
    """Delete rows in batches until none remain — handles large backlogs."""
    total = 0
    try:
        while True:
            resp = await sb.table(table).delete().lt(ts_col, cutoff_iso).execute()
            batch = len(resp.data or [])
            total += batch
            if batch == 0:
                break   # nothing left to delete
        logger.info("[DataPrune] %s: %d rows deleted (cutoff %s)", table, total, cutoff_iso[:19])
    except Exception as exc:
        logger.warning("[DataPrune] %s: error — %s", table, exc)
    return total


async def run_prune() -> dict[str, int]:
    """Delete old rows from all high-volume tables. Returns deleted counts."""
    from supabase_client import get_supabase
    sb = await get_supabase()
    now = datetime.now(timezone.utc)
    results: dict[str, int] = {}
    for table, ts_col, retain in _POLICY:
        cutoff = (now - retain).isoformat()
        results[table] = await _prune_table(sb, table, ts_col, cutoff)
    return results


async def data_prune_loop() -> None:
    """Background task: prune high-volume tables every 6 hours."""
    await asyncio.sleep(_STARTUP_DELAY_SEC)
    while True:
        try:
            results = await run_prune()
            logger.info("[DataPrune] Cycle complete: %s", results)
        except Exception as exc:
            logger.warning("[DataPrune] Loop error: %s", exc)
        await asyncio.sleep(_PRUNE_INTERVAL_SEC)
