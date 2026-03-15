"""Session loop service for auto-creating rounds on an interval."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from models.round import CreateRoundRequest
from models.round_session import CreateRoundSessionRequest
from services.round_service import create_round
from supabase_client import get_supabase


def _session_markets(market_type: str, threshold: int | None, vehicle_class: str | None) -> list[dict[str, Any]]:
    if market_type == "over_under":
        th = int(threshold or 1)
        return [
            {"label": f"Over {th} vehicles", "outcome_key": "over", "odds": 1.85},
            {"label": f"Under {th} vehicles", "outcome_key": "under", "odds": 1.85},
            {"label": f"Exactly {th} vehicles", "outcome_key": "exact", "odds": 15.0},
        ]
    if market_type == "vehicle_count":
        th = int(threshold or 1)
        cls = str(vehicle_class or "car")
        cls_label = {"car": "cars", "truck": "trucks", "bus": "buses", "motorcycle": "motorcycles"}.get(cls, cls)
        return [
            {"label": f"Over {th} {cls_label}", "outcome_key": "over", "odds": 1.85},
            {"label": f"Under {th} {cls_label}", "outcome_key": "under", "odds": 1.85},
            {"label": f"Exactly {th} {cls_label}", "outcome_key": "exact", "odds": 15.0},
        ]
    return [
        {"label": "Cars lead", "outcome_key": "car", "odds": 2.0},
        {"label": "Trucks lead", "outcome_key": "truck", "odds": 3.5},
        {"label": "Buses lead", "outcome_key": "bus", "odds": 4.0},
        {"label": "Motorcycles lead", "outcome_key": "motorcycle", "odds": 5.0},
    ]


async def create_round_session(req: CreateRoundSessionRequest) -> dict[str, Any]:
    sb = await get_supabase()
    now = datetime.now(timezone.utc)
    starts_at = now
    ends_at = now + timedelta(minutes=req.session_duration_min)

    rec = {
        "camera_id": str(req.camera_id),
        "status": "active",
        "market_type": req.market_type,
        "threshold": req.threshold,
        "vehicle_class": req.vehicle_class,
        "round_duration_min": req.round_duration_min,
        "bet_cutoff_min": req.bet_cutoff_min,
        "interval_min": req.interval_min,
        "session_duration_min": req.session_duration_min,
        "max_rounds": req.max_rounds,
        "created_rounds": 0,
        "starts_at": starts_at.isoformat(),
        "ends_at": ends_at.isoformat(),
        "next_round_at": starts_at.isoformat(),
    }
    resp = await sb.table("round_sessions").insert(rec).execute()
    return (resp.data or [{}])[0]


async def list_round_sessions(limit: int = 50) -> list[dict[str, Any]]:
    sb = await get_supabase()
    resp = await (
        sb.table("round_sessions")
        .select("*")
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return resp.data or []


async def stop_round_session(session_id: str) -> dict[str, Any]:
    sb = await get_supabase()
    now = datetime.now(timezone.utc).isoformat()
    resp = await (
        sb.table("round_sessions")
        .update({"status": "stopped", "ends_at": now})
        .eq("id", session_id)
        .execute()
    )
    return (resp.data or [{}])[0]


async def next_session_round_at() -> str | None:
    sb = await get_supabase()
    now_iso = datetime.now(timezone.utc).isoformat()
    resp = await (
        sb.table("round_sessions")
        .select("next_round_at")
        .eq("status", "active")
        .gte("next_round_at", now_iso)
        .order("next_round_at", desc=False)
        .limit(1)
        .maybeSingle()
        .execute()
    )
    return (resp.data or {}).get("next_round_at")


async def session_scheduler_tick() -> None:
    """Run one tick of session scheduler: create rounds and move next_round_at."""
    sb = await get_supabase()
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    locked_grace_iso = (now - timedelta(minutes=2)).isoformat()

    # Mark expired sessions complete.
    await (
        sb.table("round_sessions")
        .update({"status": "completed"})
        .eq("status", "active")
        .lt("ends_at", now_iso)
        .execute()
    )

    sessions_resp = await (
        sb.table("round_sessions")
        .select("*")
        .eq("status", "active")
        .lte("next_round_at", now_iso)
        .order("next_round_at", desc=False)
        .limit(20)
        .execute()
    )

    for s in sessions_resp.data or []:
        sid = s["id"]
        created_rounds = int(s.get("created_rounds") or 0)
        max_rounds = s.get("max_rounds")
        if max_rounds is not None and created_rounds >= int(max_rounds):
            await sb.table("round_sessions").update({"status": "completed"}).eq("id", sid).execute()
            continue

        # Keep one active timeline per camera for predictable UX.
        active_open_upcoming_resp = await (
            sb.table("bet_rounds")
            .select("id")
            .eq("camera_id", s["camera_id"])
            .in_("status", ["upcoming", "open"])
            .limit(1)
            .execute()
        )
        recent_locked_resp = await (
            sb.table("bet_rounds")
            .select("id")
            .eq("camera_id", s["camera_id"])
            .eq("status", "locked")
            .gte("ends_at", locked_grace_iso)
            .limit(1)
            .execute()
        )
        if active_open_upcoming_resp.data or recent_locked_resp.data:
            continue

        opens = now
        ends = opens + timedelta(minutes=int(s["round_duration_min"]))
        closes = ends - timedelta(minutes=int(s["bet_cutoff_min"]))
        if closes <= opens:
            closes = opens + timedelta(seconds=10)

        params: dict[str, Any] = {}
        if s["market_type"] in ("over_under", "vehicle_count"):
            params["threshold"] = int(s.get("threshold") or 1)
        if s["market_type"] == "vehicle_count":
            params["vehicle_class"] = s.get("vehicle_class") or "car"
        params["duration_sec"] = int(s["round_duration_min"]) * 60

        req = CreateRoundRequest(
            camera_id=s["camera_id"],
            market_type=s["market_type"],
            params=params,
            opens_at=opens,
            closes_at=closes,
            ends_at=ends,
            markets=_session_markets(s["market_type"], s.get("threshold"), s.get("vehicle_class")),
        )
        await create_round(req)

        next_round_at = ends + timedelta(minutes=int(s["interval_min"]))
        patch = {
            "created_rounds": created_rounds + 1,
            "next_round_at": next_round_at.isoformat(),
        }
        if max_rounds is not None and (created_rounds + 1) >= int(max_rounds):
            patch["status"] = "completed"
        await sb.table("round_sessions").update(patch).eq("id", sid).execute()
