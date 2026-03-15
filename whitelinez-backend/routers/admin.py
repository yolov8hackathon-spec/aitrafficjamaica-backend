"""
routers/admin.py — Admin-only round management endpoints.
POST /admin/rounds     → create a new round + markets
POST /admin/resolve    → manually resolve a round
POST /admin/set-role   → grant/revoke admin role on a user
"""
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status

from models.round import CreateRoundRequest, ResolveRoundRequest, RoundOut
from services.auth_service import validate_supabase_jwt, require_admin, get_user_id
from services.round_service import create_round, resolve_round
from supabase_client import get_supabase
from middleware.rate_limiter import limiter

router = APIRouter(prefix="/admin", tags=["admin"])


async def _require_admin_user(authorization: Annotated[str | None, Header()] = None) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing Bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    payload = await validate_supabase_jwt(token)
    require_admin(payload)
    return payload


@router.post("/rounds", response_model=RoundOut, status_code=201)
async def admin_create_round(
    body: CreateRoundRequest,
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    return await create_round(body)


@router.post("/resolve")
async def admin_resolve_round(
    body: ResolveRoundRequest,
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    await resolve_round(str(body.round_id), body.result)
    return {"message": "Round resolved", "round_id": str(body.round_id)}


@router.post("/set-role")
async def set_user_role(
    body: dict,  # {"user_id": "...", "role": "admin" | "user"}
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    """
    Set app_metadata.role on a user via Supabase Admin API.
    Only a service-role client can do this.
    """
    target_user_id = body.get("user_id")
    role = body.get("role", "user")
    if not target_user_id:
        raise HTTPException(status_code=400, detail="user_id required")
    if role not in ("admin", "user"):
        raise HTTPException(status_code=400, detail="role must be 'admin' or 'user'")

    sb = await get_supabase()
    # Supabase admin SDK: update user metadata
    resp = await sb.auth.admin.update_user_by_id(
        target_user_id,
        {"app_metadata": {"role": role}},
    )
    return {"message": f"User {target_user_id} role set to {role}"}
