"""
routers/bets.py — POST /bets/place, POST /bets/place-live, GET /bets/history
All endpoints require a valid Supabase JWT.
"""
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from typing import Annotated
from uuid import UUID

from models.bet import PlaceBetRequest, PlaceBetResponse, BetHistoryItem, PlaceLiveBetRequest, PlaceLiveBetResponse
from services.auth_service import validate_supabase_jwt, get_user_id
from services.bet_service import place_bet, place_live_bet, get_user_balance
from middleware.rate_limiter import limiter
from supabase_client import get_supabase

router = APIRouter(prefix="/bets", tags=["bets"])


async def _get_current_user(authorization: Annotated[str | None, Header()] = None) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing Bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    return await validate_supabase_jwt(token)


@router.post("/place", response_model=PlaceBetResponse)
@limiter.limit("5/minute")
async def place_bet_endpoint(
    request: Request,
    body: PlaceBetRequest,
    user: Annotated[dict, Depends(_get_current_user)],
):
    user_id = get_user_id(user)
    return await place_bet(user_id, body)


@router.post("/place-live", response_model=PlaceLiveBetResponse)
@limiter.limit("10/minute")
async def place_live_bet_endpoint(
    request: Request,
    body: PlaceLiveBetRequest,
    user: Annotated[dict, Depends(_get_current_user)],
):
    user_id = get_user_id(user)
    return await place_live_bet(user_id, body)


@router.get("/history")
async def bet_history(
    user: Annotated[dict, Depends(_get_current_user)],
    limit: int = Query(default=50, ge=1, le=200),
    round_id: UUID | None = Query(default=None),
):
    sb = await get_supabase()
    user_id = get_user_id(user)
    safe_limit = max(1, min(int(limit or 50), 200))
    query = (
        sb.table("bets")
        .select(
            "id,user_id,round_id,market_id,amount,potential_payout,status,bet_type,"
            "vehicle_class,exact_count,actual_count,baseline_count,window_start,window_duration_sec,"
            "placed_at,resolved_at,markets(label,odds,outcome_key)"
        )
        .eq("user_id", user_id)
        .order("placed_at", desc=True)
        .limit(safe_limit)
    )
    if round_id:
        query = query.eq("round_id", str(round_id))
    resp = await query.execute()
    return resp.data or []


@router.get("/my-round")
async def my_round_bets(
    user: Annotated[dict, Depends(_get_current_user)],
    round_id: UUID,
    limit: int = 20,
):
    """
    Strictly user-scoped round bets for UI widgets.
    Backend derives user_id from JWT to avoid any client-side identity drift.
    """
    sb = await get_supabase()
    user_id = get_user_id(user)
    safe_limit = max(1, min(int(limit or 20), 100))
    resp = await (
        sb.table("bets")
        .select(
            "id,user_id,round_id,market_id,amount,potential_payout,status,bet_type,"
            "vehicle_class,exact_count,actual_count,baseline_count,window_start,window_duration_sec,"
            "placed_at,resolved_at,markets(label,odds,outcome_key)"
        )
        .eq("user_id", user_id)
        .eq("round_id", str(round_id))
        .order("placed_at", desc=True)
        .limit(safe_limit)
        .execute()
    )
    return resp.data or []


@router.get("/balance")
async def get_balance(user: Annotated[dict, Depends(_get_current_user)]):
    user_id = get_user_id(user)
    balance = await get_user_balance(user_id)
    return {"balance": balance}
