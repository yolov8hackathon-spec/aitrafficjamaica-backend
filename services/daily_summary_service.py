"""
services/daily_summary_service.py — Midnight UTC daily traffic summary.

Runs as a background asyncio task. At midnight UTC each day, aggregates the
previous day's data across traffic, guesses, and stream quality, then upserts
into the `daily_summaries` table.

Table schema (create once via Supabase SQL editor):
    CREATE TABLE IF NOT EXISTS daily_summaries (
        date        date        PRIMARY KEY,
        summary     jsonb       NOT NULL,
        created_at  timestamptz DEFAULT now(),
        updated_at  timestamptz DEFAULT now()
    );

If the table doesn't exist the loop logs a warning and retries next day.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger(__name__)

_STARTUP_DELAY = 30   # seconds to wait before computing first summary


def _seconds_until_midnight_utc() -> float:
    """Seconds from now until next UTC midnight."""
    now = datetime.now(timezone.utc)
    tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return (tomorrow - now).total_seconds()


async def build_daily_summary(date: datetime) -> dict[str, Any]:
    """
    Aggregate stats for the given UTC calendar day.
    `date` should be the start of the day (00:00:00 UTC).
    """
    from supabase_client import get_supabase
    sb = await get_supabase()

    day_start = date.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=timezone.utc)
    day_end   = day_start + timedelta(days=1)
    s_iso     = day_start.isoformat()
    e_iso     = day_end.isoformat()

    # ── Traffic snapshots ────────────────────────────────────────
    snap_resp = await (
        sb.table("count_snapshots")
        .select("total, captured_at, camera_id, vehicle_breakdown")
        .gte("captured_at", s_iso)
        .lt("captured_at",  e_iso)
        .order("captured_at", desc=False)
        .limit(100000)
        .execute()
    )
    snaps = snap_resp.data or []

    total_vehicles = 0
    peak_count     = 0
    peak_hour      = None
    hour_buckets: dict[int, int] = {}
    class_totals: dict[str, int] = {}

    for s in snaps:
        total = int(s.get("total") or 0)
        total_vehicles = max(total_vehicles, total)   # cumulative max
        if total > peak_count:
            peak_count = total
            try:
                peak_hour = datetime.fromisoformat(str(s["captured_at"]).replace("Z", "+00:00")).hour
            except Exception:
                pass
        try:
            h = datetime.fromisoformat(str(s["captured_at"]).replace("Z", "+00:00")).hour
            hour_buckets[h] = max(hour_buckets.get(h, 0), total)
        except Exception:
            pass
        for cls, v in (s.get("vehicle_breakdown") or {}).items():
            class_totals[cls] = class_totals.get(cls, 0) + int(v or 0)

    busiest_hour = max(hour_buckets, key=lambda h: hour_buckets[h]) if hour_buckets else None

    # ── Guesses (bets) ────────────────────────────────────────────
    bet_resp = await (
        sb.table("bets")
        .select("status, amount, potential_payout, window_duration_sec")
        .gte("placed_at", s_iso)
        .lt("placed_at",  e_iso)
        .limit(100000)
        .execute()
    )
    bets = bet_resp.data or []
    wins      = sum(1 for b in bets if b.get("status") == "won")
    losses    = sum(1 for b in bets if b.get("status") == "lost")
    total_pts = sum(int(b.get("potential_payout") or 0) for b in bets if b.get("status") == "won")
    by_window: dict[int, dict] = {}
    for b in bets:
        w = int(b.get("window_duration_sec") or 0)
        if w not in by_window:
            by_window[w] = {"guesses": 0, "wins": 0}
        by_window[w]["guesses"] += 1
        if b.get("status") == "won":
            by_window[w]["wins"] += 1

    # ── Quality snapshots (best + worst camera for the day) ───────
    cam_resp = await (
        sb.table("cameras")
        .select("id, ipcam_alias, quality_snapshot, feed_appearance")
        .execute()
    )
    cams = cam_resp.data or []
    best_cam  = max(
        (c for c in cams if c.get("quality_snapshot", {}) and c["quality_snapshot"].get("quality_score") is not None),
        key=lambda c: c["quality_snapshot"]["quality_score"],
        default=None,
    )
    worst_cam = min(
        (c for c in cams if c.get("quality_snapshot", {}) and c["quality_snapshot"].get("quality_score") is not None),
        key=lambda c: c["quality_snapshot"]["quality_score"],
        default=None,
    )

    def _cam_label(c: dict) -> str:
        return (c.get("feed_appearance") or {}).get("label") or c.get("ipcam_alias") or str(c.get("id", ""))

    return {
        "date": day_start.date().isoformat(),
        "traffic": {
            "peak_count": peak_count,
            "peak_hour": peak_hour,
            "busiest_hour": busiest_hour,
            "hour_buckets": hour_buckets,
            "class_totals": class_totals,
            "snapshot_count": len(snaps),
        },
        "guesses": {
            "total": len(bets),
            "wins": wins,
            "losses": losses,
            "total_pts_awarded": total_pts,
            "by_window": {str(k): v for k, v in by_window.items()},
        },
        "quality": {
            "best_camera": _cam_label(best_cam) if best_cam else None,
            "best_score": best_cam["quality_snapshot"]["quality_score"] if best_cam else None,
            "worst_camera": _cam_label(worst_cam) if worst_cam else None,
            "worst_score": worst_cam["quality_snapshot"]["quality_score"] if worst_cam else None,
        },
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


async def _write_summary(summary: dict[str, Any]) -> None:
    from supabase_client import get_supabase
    try:
        sb = await get_supabase()
        await (
            sb.table("daily_summaries")
            .upsert(
                {"date": summary["date"], "summary": summary, "updated_at": summary["generated_at"]},
                on_conflict="date",
            )
            .execute()
        )
        logger.info("Daily summary written for %s", summary["date"])
    except Exception as exc:
        logger.warning("daily_summaries write failed (table may not exist yet): %s", exc)


async def daily_summary_loop() -> None:
    """
    Background task: sleeps until midnight UTC, then builds and persists
    the previous day's summary. Repeats indefinitely.
    """
    await asyncio.sleep(_STARTUP_DELAY)

    # Compute yesterday's summary on first boot if it hasn't been written yet
    try:
        yesterday = datetime.now(timezone.utc) - timedelta(days=1)
        summary = await build_daily_summary(yesterday)
        await _write_summary(summary)
    except Exception as exc:
        logger.warning("Boot-time summary failed: %s", exc)

    while True:
        wait = _seconds_until_midnight_utc()
        logger.info("DailySummary: next run in %.0fs (at midnight UTC)", wait)
        await asyncio.sleep(wait + 5)   # +5s to ensure we're past midnight

        try:
            yesterday = datetime.now(timezone.utc) - timedelta(days=1)
            summary = await build_daily_summary(yesterday)
            await _write_summary(summary)
        except Exception as exc:
            logger.warning("Daily summary loop error: %s", exc)
