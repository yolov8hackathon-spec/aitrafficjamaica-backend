"""
routers/rounds.py — GET /rounds/current, GET /rounds/{id}
Public endpoints — no auth required (RLS allows public read).
"""
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query

from models.round import RoundOut
from services.round_service import get_current_round
from supabase_client import get_supabase

router = APIRouter(prefix="/rounds", tags=["rounds"])


@router.get("/current", response_model=RoundOut | None)
async def current_round(camera_id: str | None = Query(default=None)):
    return await get_current_round(camera_id)


@router.get("/leaderboard", response_model=None)
async def leaderboard(window: int = Query(60, description="60, 180, or 300")):
    """Cached pre-aggregated leaderboard. Refreshes every 60s server-side."""
    from services.leaderboard_service import get_leaderboard
    if window not in (60, 180, 300):
        raise HTTPException(status_code=400, detail="window must be 60, 180, or 300")
    return get_leaderboard(window)


@router.get("/{round_id}", response_model=RoundOut)
async def get_round(round_id: UUID):
    sb = await get_supabase()
    resp = await sb.table("bet_rounds").select("*, markets(*)").eq("id", str(round_id)).single().execute()
    if not resp.data:
        raise HTTPException(status_code=404, detail="Round not found")
    return resp.data
