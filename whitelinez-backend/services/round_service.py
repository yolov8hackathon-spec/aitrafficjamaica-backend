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


async def create_round(req: CreateRoundRequest) -> RoundOut:
    """Create a new bet round + associated markets in one batch."""
    sb = await get_supabase()

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
    params = rnd["params"]
    market_type = rnd["market_type"]

    # Compute winning outcome key(s) from result
    winning_keys = _compute_winners(market_type, params, result)
    logger.info("Round %s resolved. Winners: %s", round_id, winning_keys)

    # Mark round resolved
    await sb.table("bet_rounds").update({
        "status": "resolved",
        "result": result,
    }).eq("id", round_id).execute()

    # Fetch all pending bets for this round with market outcome_key
    bets_resp = await sb.table("bets").select(
        "id, user_id, amount, potential_payout, markets(outcome_key)"
    ).eq("round_id", round_id).eq("status", "pending").execute()

    for bet in (bets_resp.data or []):
        outcome_key = bet["markets"]["outcome_key"]
        won = outcome_key in winning_keys

        await sb.table("bets").update({
            "status": "won" if won else "lost",
            "resolved_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", bet["id"]).execute()

        if won:
            await sb.rpc("credit_user_balance", {
                "p_user_id": bet["user_id"],
                "p_amount": bet["potential_payout"],
            }).execute()
            logger.info("Credited %d to user %s (bet %s)", bet["potential_payout"], bet["user_id"], bet["id"])


def _compute_winners(market_type: str, params: dict, result: dict) -> list[str]:
    """Determine which outcome_keys win based on result."""
    total = result.get("total", 0)

    if market_type == "over_under":
        threshold = params.get("threshold", 0)
        if total > threshold:
            return ["over"]
        elif total < threshold:
            return ["under"]
        else:
            return ["exact"]

    if market_type == "vehicle_type":
        # winner is the vehicle class with the highest count
        breakdown = result.get("by_class", {})
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
