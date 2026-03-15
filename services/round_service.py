"""
round_service.py — Create, lock, resolve rounds and trigger payouts.
All DB writes use service role client.
"""
import logging
from uuid import UUID
from datetime import datetime, timezone
from typing import Any

from supabase_client import get_supabase
from models.round import CreateRoundRequest, RoundOut

logger = logging.getLogger(__name__)


def _is_valid_count_line(count_line: Any) -> bool:
    """
    Accepts either:
    - 2-point line: x1,y1,x2,y2
    - 4-point polygon: x1,y1,x2,y2,x3,y3,x4,y4
    Values must be numeric and normalized in [0, 1].
    """
    if not isinstance(count_line, dict):
        return False

    has_poly = all(k in count_line for k in ("x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4"))
    has_line = all(k in count_line for k in ("x1", "y1", "x2", "y2"))
    if not (has_poly or has_line):
        return False

    keys = ("x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4") if has_poly else ("x1", "y1", "x2", "y2")
    for k in keys:
        v = count_line.get(k)
        if not isinstance(v, (int, float)):
            return False
        if v < 0 or v > 1:
            return False
    return True


async def create_round(req: CreateRoundRequest) -> RoundOut:
    """Create a new bet round + associated markets in one batch."""
    sb = await get_supabase()

    cam_resp = await sb.table("cameras").select("id, count_line").eq("id", str(req.camera_id)).single().execute()
    camera = cam_resp.data or {}
    if not camera:
        raise ValueError("Selected camera was not found.")
    if not _is_valid_count_line(camera.get("count_line")):
        raise ValueError("Count area is not set. Save a valid count zone before creating a round.")

    round_data = {
        "camera_id": str(req.camera_id),
        "market_type": req.market_type,
        "params": req.params,
        "status": "upcoming",
        "opens_at": req.opens_at.isoformat(),
        "closes_at": req.closes_at.isoformat(),
        "ends_at": req.ends_at.isoformat(),
    }
    rnd_resp = await sb.table("bet_rounds").insert(round_data).execute()
    rnd = rnd_resp.data[0]
    round_id = rnd["id"]

    markets_data = [
        {
            "round_id": round_id,
            "label": m["label"],
            "outcome_key": m["outcome_key"],
            "odds": m["odds"],
            "total_staked": 0,
        }
        for m in req.markets
    ]
    mkt_resp = await sb.table("markets").insert(markets_data).execute()

    return RoundOut(**rnd, markets=mkt_resp.data)


async def resolve_round(round_id: str, result: dict[str, Any]) -> None:
    """
    Resolve a round:
    1. Mark round as resolved
    2. Evaluate each bet against result
    3. Credit winners via place_payout RPC
    """
    sb = await get_supabase()

    round_resp = await sb.table("bet_rounds").select("*").eq("id", round_id).single().execute()
    if not round_resp.data:
        raise ValueError(f"Round {round_id} not found")

    rnd = round_resp.data
    params = rnd["params"] or {}
    market_type = rnd["market_type"]

    # Mark round resolved
    await sb.table("bet_rounds").update({
        "status": "resolved",
        "result": result,
    }).eq("id", round_id).execute()

    # Fetch all pending market bets for this round with market outcome_key
    bets_resp = await (
        sb.table("bets")
        .select("id, user_id, potential_payout, baseline_count, placed_at, markets(outcome_key)")
        .eq("round_id", round_id)
        .eq("status", "pending")
        .or_("bet_type.eq.market,bet_type.is.null")
        .execute()
    )

    total = int(result.get("total", 0) or 0)
    breakdown = result.get("vehicle_breakdown", result.get("by_class", {})) or {}
    threshold = int(params.get("threshold", 0) or 0)
    vehicle_class = str(params.get("vehicle_class") or "")

    async def _round_start_baseline() -> int:
        round_baseline_total = int(params.get("round_baseline_total", 0) or 0)
        round_baseline_by_class = params.get("round_baseline_by_class") or {}
        if market_type == "vehicle_count":
            persisted = int(round_baseline_by_class.get(vehicle_class, 0) or 0)
        else:
            persisted = round_baseline_total
        if persisted > 0:
            return persisted
        if not rnd.get("camera_id") or not rnd.get("opens_at"):
            return 0
        try:
            snap_resp = await (
                sb.table("count_snapshots")
                .select("total, vehicle_breakdown")
                .eq("camera_id", rnd["camera_id"])
                .lte("captured_at", rnd["opens_at"])
                .order("captured_at", desc=True)
                .limit(1)
                .execute()
            )
            if snap_resp.data:
                snap = snap_resp.data[0]
            else:
                snap_after = await (
                    sb.table("count_snapshots")
                    .select("total, vehicle_breakdown")
                    .eq("camera_id", rnd["camera_id"])
                    .gte("captured_at", rnd["opens_at"])
                    .order("captured_at", desc=False)
                    .limit(1)
                    .execute()
                )
                if not snap_after.data:
                    return 0
                snap = snap_after.data[0]
            if market_type == "vehicle_count":
                return int((snap.get("vehicle_breakdown") or {}).get(vehicle_class, 0) or 0)
            return int(snap.get("total", 0) or 0)
        except Exception:
            return 0

    async def _baseline_from_snapshot(placed_at_iso: str | None) -> int:
        if not rnd.get("camera_id") or not placed_at_iso:
            return 0
        try:
            snap_resp = await (
                sb.table("count_snapshots")
                .select("total, vehicle_breakdown")
                .eq("camera_id", rnd["camera_id"])
                .lte("captured_at", placed_at_iso)
                .order("captured_at", desc=True)
                .limit(1)
                .execute()
            )
            if not snap_resp.data:
                return 0
            snap = snap_resp.data[0]
            if market_type == "vehicle_count":
                return int((snap.get("vehicle_breakdown") or {}).get(vehicle_class, 0) or 0)
            return int(snap.get("total", 0) or 0)
        except Exception:
            return 0

    # For over/under and vehicle_count, settlement is per-bet from placement baseline.
    if market_type in ("over_under", "vehicle_count"):
        logger.info("Round %s resolved with per-bet settlement (%s)", round_id, market_type)
        round_baseline = await _round_start_baseline()
        for bet in (bets_resp.data or []):
            market_data = bet.get("markets") or {}
            outcome_key = (market_data.get("outcome_key") or "").lower()
            if outcome_key not in {"over", "under", "exact"}:
                continue

            baseline = (
                int(bet["baseline_count"])
                if bet.get("baseline_count") is not None
                else await _baseline_from_snapshot(bet.get("placed_at"))
            )
            # Guard against stale/late baseline writes by anchoring to placement snapshot.
            snap_baseline = await _baseline_from_snapshot(bet.get("placed_at"))
            baseline = max(int(baseline or 0), int(snap_baseline or 0), int(round_baseline or 0))
            current = total if market_type == "over_under" else int(breakdown.get(vehicle_class, 0) or 0)
            actual = max(0, current - baseline)
            if actual > threshold:
                win_key = "over"
            elif actual < threshold:
                win_key = "under"
            else:
                win_key = "exact"
            won = (outcome_key == win_key)

            await sb.table("bets").update({
                "status": "won" if won else "lost",
                "actual_count": actual,
                "resolved_at": datetime.now(timezone.utc).isoformat(),
            }).eq("id", bet["id"]).execute()

            if won:
                await sb.rpc("credit_user_balance", {
                    "p_user_id": bet["user_id"],
                    "p_amount": int(bet["potential_payout"]),
                }).execute()
                logger.info("Credited %d to user %s (bet %s)", bet["potential_payout"], bet["user_id"], bet["id"])
        return

    # Other market types remain round-global settlement.
    winning_keys = _compute_winners(market_type, params, result)
    logger.info("Round %s resolved. Winners: %s", round_id, winning_keys)

    for bet in (bets_resp.data or []):
        market_data = bet.get("markets") or {}
        outcome_key = market_data.get("outcome_key")
        if not outcome_key:
            continue
        won = outcome_key in winning_keys

        await sb.table("bets").update({
            "status": "won" if won else "lost",
            "resolved_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", bet["id"]).execute()

        if won:
            await sb.rpc("credit_user_balance", {
                "p_user_id": bet["user_id"],
                "p_amount": int(bet["potential_payout"]),
            }).execute()
            logger.info("Credited %d to user %s (bet %s)", bet["potential_payout"], bet["user_id"], bet["id"])


async def resolve_round_from_latest_snapshot(round_id: str) -> dict[str, Any]:
    """
    Resolve a round using the latest count snapshot for its camera.
    Returns the result payload used for resolution.
    """
    sb = await get_supabase()
    rnd_resp = await sb.table("bet_rounds").select("id, camera_id").eq("id", round_id).single().execute()
    if not rnd_resp.data:
        raise ValueError(f"Round {round_id} not found")

    camera_id = rnd_resp.data.get("camera_id")
    result: dict[str, Any] = {"total": 0, "vehicle_breakdown": {}}

    if camera_id:
        snap_resp = await (
            sb.table("count_snapshots")
            .select("total, vehicle_breakdown")
            .eq("camera_id", camera_id)
            .order("captured_at", desc=True)
            .limit(1)
            .execute()
        )
        if snap_resp.data:
            snap = snap_resp.data[0]
            result = {
                "total": snap.get("total", 0) or 0,
                "vehicle_breakdown": snap.get("vehicle_breakdown") or {},
            }

    await resolve_round(round_id, result)
    return result


def _compute_winners(market_type: str, params: dict, result: dict) -> list[str]:
    """Determine which outcome_keys win based on result."""
    total     = result.get("total", 0)
    breakdown = result.get("vehicle_breakdown", result.get("by_class", {}))

    if market_type == "over_under":
        threshold = params.get("threshold", 0)
        if total > threshold:
            return ["over"]
        elif total < threshold:
            return ["under"]
        else:
            return ["exact"]

    if market_type == "vehicle_count":
        vehicle_class = params.get("vehicle_class", "")
        threshold     = params.get("threshold", 0)
        count         = breakdown.get(vehicle_class, 0)
        if count > threshold:
            return ["over"]
        elif count < threshold:
            return ["under"]
        else:
            return ["exact"]

    if market_type == "vehicle_type":
        # Winner is the class with the highest count
        if not breakdown:
            return []
        winner = max(breakdown, key=lambda k: breakdown[k])
        return [winner]

    # custom: params must carry winning_key
    return [params.get("winning_key", "")]


async def get_current_round(camera_id: str | None = None) -> dict | None:
    """Return the most recent open round (optionally filtered by camera)."""
    sb = await get_supabase()
    query = (
        sb.table("bet_rounds")
        .select("*, markets(*)")
        .in_("status", ["upcoming", "open"])
        .order("opens_at", desc=False)
        .limit(1)
    )
    if camera_id:
        query = query.eq("camera_id", camera_id)

    resp = await query.execute()
    return resp.data[0] if resp.data else None
