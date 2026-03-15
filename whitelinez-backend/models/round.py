"""Pydantic schemas for round and market request/response payloads."""
from uuid import UUID
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field


class MarketOut(BaseModel):
    id: UUID
    label: str
    outcome_key: str
    odds: float
    total_staked: int


class RoundOut(BaseModel):
    id: UUID
    camera_id: UUID
    market_type: str
    params: dict[str, Any]
    status: str
    opens_at: Optional[datetime] = None
    closes_at: Optional[datetime] = None
    ends_at: Optional[datetime] = None
    result: Optional[dict[str, Any]] = None
    created_at: datetime
    markets: list[MarketOut] = []


class CreateRoundRequest(BaseModel):
    camera_id: UUID
    market_type: str = Field(..., pattern="^(over_under|vehicle_type|custom)$")
    params: dict[str, Any]
    opens_at: datetime
    closes_at: datetime
    ends_at: datetime
    markets: list[dict[str, Any]] = Field(..., min_length=1)


class ResolveRoundRequest(BaseModel):
    round_id: UUID
    result: dict[str, Any]  # {total, by_class}
