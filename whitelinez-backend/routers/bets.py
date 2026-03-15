"""
routers/bets.py — POST /bets/place, GET /bets/history
All endpoints require a valid Supabase JWT.
"""
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from slowapi.errors import RateLimitExceeded
from typing import Annotated

from models.bet import PlaceBetRequest, PlaceBetResponse, BetHistoryItem
from services.auth_service import validate_supabase_jwt, get_user_id
from services.bet_service import place_bet, get_user_balance
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


@router.get("/history", response_model=list[BetHistoryItem])
async def bet_history(
    user: Annotated[dict, Depends(_get_current_user)],
    limit: int = 50,
):
    sb = await get_supabase()
    user_id = get_user_id(user)
    resp = await (
        sb.table("bets")
        .select("*")
        .eq("user_id", user_id)
        .order("placed_at", desc=True)
        .limit(limit)
        .execute()
    )
    return resp.data or []


@router.get("/balance")
async def get_balance(user: Annotated[dict, Depends(_get_current_user)]):
    user_id = get_user_id(user)
    balance = await get_user_balance(user_id)
    return {"balance": balance}
