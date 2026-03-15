"""
Shared FastAPI auth dependencies to avoid duplicated Bearer/JWT checks in routers.
"""
from typing import Annotated

from fastapi import Header, HTTPException, status

from services.auth_service import require_admin, validate_supabase_jwt


async def require_bearer_user(authorization: Annotated[str | None, Header()] = None) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing Bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    return await validate_supabase_jwt(token)


async def require_bearer_admin(authorization: Annotated[str | None, Header()] = None) -> dict:
    payload = await require_bearer_user(authorization)
    require_admin(payload)
    return payload
