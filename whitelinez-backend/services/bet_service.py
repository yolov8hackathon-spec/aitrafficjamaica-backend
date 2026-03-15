"""
bet_service.py — Atomic bet placement.
Balance check + deduct + bet insert all run in one PostgreSQL transaction
via the service role client (bypasses RLS for the transaction, but we
enforce ownership manually).
"""
import logging
from uuid import UUID
from datetime import datetime, timezone

from supabase_client import get_supabase
from models.bet import PlaceBetRequest, PlaceBetResponse

logger = logging.getLogger(__name__)

INITIAL_BALANCE = 1000  # credits granted to new users


async def place_bet(user_id: str, req: PlaceBetRequest) -> PlaceBetResponse:
    """
    Atomically place a bet:
    1. Verify the round is still open (closes_at not passed)
    2. Verify the market belongs to the round
    3. Fetch current user balance from auth.users app_metadata
    4. Check sufficient funds
    5. Deduct balance + insert bet in one RPC call
    Returns the placed bet details.
    """
    sb = await get_supabase()

    # 1. Fetch round and check it's open
    round_resp = await sb.table("bet_rounds").select("*").eq("id", str(req.round_id)).single().execute()
    if not round_resp.data:
        from fastapi import HTTPException, status
        raise HTTPException(status_code=404, detail="Round not found")

    rnd = round_resp.data
    now = datetime.now(timezone.utc)

    if rnd["status"] != "open":
        from fastapi import HTTPException, status
        raise HTTPException(status_code=400, detail=f"Round is {rnd['status']}, bets not accepted")

    closes_at = datetime.fromisoformat(rnd["closes_at"].replace("Z", "+00:00"))
    if now >= closes_at:
        from fastapi import HTTPException, status
        raise HTTPException(status_code=403, detail="Betting window has closed")

    # 2. Fetch market and confirm it belongs to the round
    mkt_resp = await sb.table("markets").select("*").eq("id", str(req.market_id)).eq("round_id", str(req.round_id)).single().execute()
    if not mkt_resp.data:
        from fastapi import HTTPException, status
        raise HTTPException(status_code=404, detail="Market not found in this round")

    market = mkt_resp.data
    odds = float(market["odds"])
    potential_payout = int(req.amount * odds)

    # 3–5. Use a DB-level RPC for atomic balance check + deduct + insert
    rpc_resp = await sb.rpc("place_bet_atomic", {
        "p_user_id": user_id,
        "p_round_id": str(req.round_id),
        "p_market_id": str(req.market_id),
        "p_amount": req.amount,
        "p_potential_payout": potential_payout,
    }).execute()

    if rpc_resp.data and isinstance(rpc_resp.data, dict) and rpc_resp.data.get("error"):
        from fastapi import HTTPException, status
        raise HTTPException(status_code=400, detail=rpc_resp.data["error"])

    bet_id = rpc_resp.data["bet_id"] if isinstance(rpc_resp.data, dict) else rpc_resp.data[0]["bet_id"]

    return PlaceBetResponse(
        bet_id=bet_id,
        status="pending",
        amount=req.amount,
        potential_payout=potential_payout,
        placed_at=datetime.now(timezone.utc),
    )


async def get_user_balance(user_id: str) -> int:
    """
    Read user balance from user_balances view or app_metadata.
    Falls back to INITIAL_BALANCE if no record found.
    """
    sb = await get_supabase()
    resp = await sb.rpc("get_user_balance", {"p_user_id": user_id}).execute()
    if resp.data is not None:
        return int(resp.data)
    return INITIAL_BALANCE
