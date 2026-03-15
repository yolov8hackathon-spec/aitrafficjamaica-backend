"""
services/traffic_daily_service.py — Nightly aggregation of vehicle_crossings → traffic_daily.

Runs as a background asyncio task. At midnight UTC each day, aggregates the
previous day's entry-zone crossings into traffic_daily (one row per camera per day).

Only zone_source='entry' rows are counted — these represent true intersection
throughput, not the game count line.

The traffic_daily table is the fast path for analytics/traffic.js when
granularity=day or granularity=week, avoiding expensive live queries.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger(__name__)

_STARTUP_DELAY = 45   # seconds after boot before first run
_RETRY_DELAY   = 300  # retry in 5 min on failure


def _seconds_until_midnight_utc() -> float:
    now      = datetime.now(timezone.utc)
    tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return (tomorrow - now).total_seconds()


async def aggregate_day(date: datetime) -> dict[str, Any]:
    """
    Aggregate entry-zone crossings for the given UTC calendar day into traffic_daily.
    Returns a summary dict of rows upserted.
    """
    from supabase_client import get_supabase
    sb = await get_supabase()

    day_start = date.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=timezone.utc)
    day_end   = day_start + timedelta(days=1)
    s_iso     = day_start.isoformat()
    e_iso     = day_end.isoformat()
    date_str  = day_start.date().isoformat()

    # Fetch all cameras
    cams_resp = await sb.table("cameras").select("id").execute()
    camera_ids = [c["id"] for c in (cams_resp.data or [])]
    if not camera_ids:
        logger.info("[TrafficDaily] No cameras found, skipping %s", date_str)
        return {"date": date_str, "cameras": 0, "rows": 0}

    _PAGE = 1000  # PostgREST max_rows cap — paginate to fetch all rows

    async def _paginate(base_query) -> list:
        """Exhaust a supabase-py query builder by fetching _PAGE rows at a time."""
        all_rows: list = []
        offset = 0
        while True:
            page = (await base_query.range(offset, offset + _PAGE - 1).execute()).data or []
            all_rows.extend(page)
            if len(page) < _PAGE:
                break
            offset += _PAGE
        return all_rows

    # Fetch entry-zone and game-zone crossings for the day (all cameras in one query)
    rows = await _paginate(
        sb.table("vehicle_crossings")
        .select("camera_id,vehicle_class,direction,confidence,speed_kmh,captured_at")
        .in_("zone_source", ["entry", "game"])
        .gte("captured_at", s_iso)
        .lt("captured_at",  e_iso)
    )

    # Fetch turning movements for the day — these are the outbound (exit) counts
    tm_rows = await _paginate(
        sb.table("turning_movements")
        .select("camera_id,entry_zone,exit_zone,vehicle_class,captured_at")
        .gte("captured_at", s_iso)
        .lt("captured_at",  e_iso)
    )

    # Fetch queue depth snapshots for the day (avg/peak per camera)
    snaps = await _paginate(
        sb.table("traffic_snapshots")
        .select("camera_id,queue_depth,captured_at")
        .gte("captured_at", s_iso)
        .lt("captured_at",  e_iso)
    )

    # ── Aggregate per camera ──────────────────────────────────────────────────
    # buckets[camera_id] = {total, car, truck, bus, motorcycle, in, out, hourly, speeds, queues}
    # hourly[h] = {total, in, out, car, truck, bus, motorcycle}
    buckets: dict[str, dict] = {}

    def _ensure_bucket(cid: str) -> dict:
        if cid not in buckets:
            buckets[cid] = {
                "total": 0, "car": 0, "truck": 0, "bus": 0, "motorcycle": 0,
                "in": 0, "out": 0,
                "hourly": {},    # hour(int) → {total,in,out,car,truck,bus,motorcycle}
                "matrix": {},    # "EntryZone→ExitZone" → {total,car,truck,bus,motorcycle}
                "speeds": [],
                "queues": [],
            }
        return buckets[cid]

    def _ensure_hour(b: dict, h: int) -> dict:
        if h not in b["hourly"]:
            b["hourly"][h] = {"total": 0, "in": 0, "out": 0, "car": 0, "truck": 0, "bus": 0, "motorcycle": 0}
        return b["hourly"][h]

    for r in rows:
        cid = r.get("camera_id")
        if not cid:
            continue
        b = _ensure_bucket(cid)
        cls = (r.get("vehicle_class") or "").lower()
        if cls not in ("car", "truck", "bus", "motorcycle"):
            continue  # skip non-vehicle detections (traffic lights, persons, etc.)

        b["total"] += 1
        b[cls] += 1

        if r.get("direction") == "in":
            b["in"] += 1
        elif r.get("direction") == "out":
            b["out"] += 1

        if r.get("speed_kmh") is not None:
            try:
                b["speeds"].append(float(r["speed_kmh"]))
            except (ValueError, TypeError):
                pass

        try:
            h = datetime.fromisoformat(str(r["captured_at"]).replace("Z", "+00:00")).hour
            hb = _ensure_hour(b, h)
            hb["total"] += 1
            hb[cls]     += 1
            direction = r.get("direction", "")
            if direction == "in":
                hb["in"] += 1
            elif direction == "out":
                hb["out"] += 1
        except Exception:
            pass

    # ── Process turning_movements → count_out + hour_buckets.out + turning_matrix ──
    # per-camera outbound totals from turning_movements
    tm_counts: dict[str, int] = {}
    for r in tm_rows:
        cid = r.get("camera_id")
        if not cid:
            continue
        b   = _ensure_bucket(cid)
        cls = (r.get("vehicle_class") or "").lower()
        if cls not in ("car", "truck", "bus", "motorcycle"):
            cls = "car"

        # Outbound total
        tm_counts[cid] = tm_counts.get(cid, 0) + 1

        # Hourly outbound
        try:
            h  = datetime.fromisoformat(str(r["captured_at"]).replace("Z", "+00:00")).hour
            hb = _ensure_hour(b, h)
            hb["out"] += 1
        except Exception:
            pass

        # Turning matrix
        entry = (r.get("entry_zone") or "Unknown").strip()
        exit_ = (r.get("exit_zone")  or "Unknown").strip()
        key   = f"{entry}→{exit_}"
        if key not in b["matrix"]:
            b["matrix"][key] = {"total": 0, "car": 0, "truck": 0, "bus": 0, "motorcycle": 0}
        b["matrix"][key]["total"] += 1
        b["matrix"][key][cls]     += 1

    # Attach queue depths to camera buckets
    for s in snaps:
        cid = s.get("camera_id")
        qd  = s.get("queue_depth")
        if cid and qd is not None:
            b = _ensure_bucket(cid)
            try:
                b["queues"].append(float(qd))
            except (ValueError, TypeError):
                pass

    # ── Build upsert rows ─────────────────────────────────────────────────────
    upsert_rows = []
    for cid, b in buckets.items():
        # Peak hour from inbound hourly totals
        peak_hour = None
        if b["hourly"]:
            peak_hour = max(b["hourly"], key=lambda h: b["hourly"][h]["total"])

        avg_queue  = round(sum(b["queues"]) / len(b["queues"]), 2) if b["queues"] else None
        peak_queue = int(max(b["queues"])) if b["queues"] else 0
        avg_speed  = round(sum(b["speeds"]) / len(b["speeds"]), 1) if b["speeds"] else None

        # hour_buckets: stringify keys for JSON (hours as strings "0"-"23")
        hour_buckets = {str(h): v for h, v in b["hourly"].items()} if b["hourly"] else None
        turning_matrix = b["matrix"] if b["matrix"] else None

        upsert_rows.append({
            "camera_id":        cid,
            "date":             date_str,
            "total_crossings":  b["total"],
            "car_count":        b["car"],
            "truck_count":      b["truck"],
            "bus_count":        b["bus"],
            "motorcycle_count": b["motorcycle"],
            "count_in":         b["in"],
            "count_out":        tm_counts.get(cid, 0),   # from turning_movements
            "avg_queue_depth":  avg_queue,
            "peak_queue_depth": peak_queue,
            "peak_hour":        peak_hour,
            "avg_speed_kmh":    avg_speed,
            "hour_buckets":     hour_buckets,
            "turning_matrix":   turning_matrix,
        })

    if upsert_rows:
        await (
            sb.table("traffic_daily")
            .upsert(upsert_rows, on_conflict="camera_id,date")
            .execute()
        )

    logger.info(
        "[TrafficDaily] %s: aggregated %d crossings + %d turning movements across %d camera(s)",
        date_str, len(rows), len(tm_rows), len(buckets),
    )
    return {"date": date_str, "cameras": len(buckets), "rows": len(rows)}


async def traffic_daily_loop() -> None:
    """
    Background task: sleeps until midnight UTC, then aggregates the previous
    day's entry-zone crossings into traffic_daily. Repeats indefinitely.

    Also runs yesterday's aggregation on boot so the table is never empty after
    a redeploy.
    """
    await asyncio.sleep(_STARTUP_DELAY)

    # Boot-time: aggregate yesterday so analytics has data immediately
    try:
        yesterday = datetime.now(timezone.utc) - timedelta(days=1)
        await aggregate_day(yesterday)
    except Exception as exc:
        logger.warning("[TrafficDaily] Boot-time aggregation failed: %s", exc)

    while True:
        wait = _seconds_until_midnight_utc()
        logger.info("[TrafficDaily] Next run in %.0fs (at midnight UTC)", wait)
        await asyncio.sleep(wait + 10)   # +10s buffer past midnight

        try:
            yesterday = datetime.now(timezone.utc) - timedelta(days=1)
            await aggregate_day(yesterday)
        except Exception as exc:
            logger.warning("[TrafficDaily] Loop error: %s", exc)
            await asyncio.sleep(_RETRY_DELAY)
