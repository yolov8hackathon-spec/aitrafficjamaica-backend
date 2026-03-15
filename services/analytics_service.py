"""
services/analytics_service.py - Admin analytics and ML telemetry summaries.
"""
from datetime import datetime, timedelta, timezone
from typing import Any

from supabase_client import get_supabase


def _to_iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


async def get_analytics_overview(hours: int = 24) -> dict[str, Any]:
    """
    Return traffic/betting/ML summary for the requested lookback window.
    """
    sb = await get_supabase()
    now = datetime.now(timezone.utc)
    since = now - timedelta(hours=max(1, min(hours, 24 * 14)))
    since_iso = _to_iso(since)

    # Traffic snapshots
    snap_resp = await (
        sb.table("count_snapshots")
        .select("captured_at, total, vehicle_breakdown")
        .gte("captured_at", since_iso)
        .order("captured_at", desc=False)
        .limit(10000)
        .execute()
    )
    snaps = snap_resp.data or []

    sample_count = len(snaps)
    peak_total = 0
    avg_total = 0.0
    class_totals: dict[str, int] = {}
    if sample_count:
        total_sum = 0
        for s in snaps:
            total = int(s.get("total") or 0)
            total_sum += total
            peak_total = max(peak_total, total)
            bd = s.get("vehicle_breakdown") or {}
            for k, v in bd.items():
                class_totals[k] = class_totals.get(k, 0) + int(v or 0)
        avg_total = total_sum / sample_count

    # Bets summary
    bets_resp = await (
        sb.table("bets")
        .select("amount, status, bet_type, potential_payout, placed_at")
        .gte("placed_at", since_iso)
        .limit(10000)
        .execute()
    )
    bets = bets_resp.data or []
    bet_count = len(bets)
    bet_volume = sum(int(b.get("amount") or 0) for b in bets)
    pending_count = sum(1 for b in bets if b.get("status") == "pending")
    won_count = sum(1 for b in bets if b.get("status") == "won")
    exact_count = sum(1 for b in bets if b.get("bet_type") == "exact_count")
    market_count = sum(1 for b in bets if b.get("bet_type") == "market")

    # ML telemetry (optional table for model health)
    ml_points = 0
    avg_detection_conf = 0.0
    try:
        ml_resp = await (
            sb.table("ml_detection_events")
            .select("avg_confidence")
            .gte("captured_at", since_iso)
            .limit(10000)
            .execute()
        )
        ml_rows = ml_resp.data or []
        ml_points = len(ml_rows)
        if ml_points:
            avg_detection_conf = sum(float(r.get("avg_confidence") or 0.0) for r in ml_rows) / ml_points
    except Exception:
        # Keep endpoint resilient if migration has not been applied yet.
        pass

    return {
        "window_hours": hours,
        "from": since_iso,
        "to": _to_iso(now),
        "traffic": {
            "snapshot_count": sample_count,
            "avg_total": round(avg_total, 3),
            "peak_total": peak_total,
            "class_totals": class_totals,
        },
        "bets": {
            "bet_count": bet_count,
            "bet_volume": bet_volume,
            "pending_count": pending_count,
            "won_count": won_count,
            "market_count": market_count,
            "exact_count": exact_count,
        },
        "ml": {
            "telemetry_points": ml_points,
            "avg_detection_confidence": round(avg_detection_conf, 4),
        },
    }


async def write_ml_detection_event(camera_id: str, snapshot: dict[str, Any], model_name: str, yolo_conf: float) -> None:
    """
    Persist lightweight model telemetry rows used for admin analytics and retraining decisions.
    """
    try:
        sb = await get_supabase()
        detections = snapshot.get("detections") or []
        confs = [float(d.get("conf")) for d in detections if d.get("conf") is not None]
        avg_conf = (sum(confs) / len(confs)) if confs else 0.0
        class_counts: dict[str, int] = {}
        for d in detections:
            cls = d.get("cls", "unknown")
            class_counts[cls] = class_counts.get(cls, 0) + 1

        row = {
            "camera_id": camera_id,
            "captured_at": snapshot.get("captured_at"),
            "model_name": model_name,
            "model_conf_threshold": yolo_conf,
            "detections_count": len(detections),
            "avg_confidence": round(avg_conf, 4),
            "class_counts": class_counts,
            "new_crossings": int(snapshot.get("new_crossings", 0) or 0),
            "scene_lighting": snapshot.get("scene_lighting"),
            "scene_weather": snapshot.get("scene_weather"),
        }
        await sb.table("ml_detection_events").insert(row).execute()
    except Exception:
        # Do not let telemetry writes impact the real-time detection loop.
        return
