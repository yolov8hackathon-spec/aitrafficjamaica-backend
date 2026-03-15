"""Pydantic schemas for bet-related request/response payloads."""
from uuid import UUID
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, field_validator


class PlaceBetRequest(BaseModel):
    round_id: UUID
    market_id: UUID
    amount: int = Field(..., gt=0, description="Credits to stake — must be positive")


class PlaceBetResponse(BaseModel):
    bet_id: UUID
    status: str
    amount: int
    potential_payout: int
    placed_at: datetime


class BetHistoryItem(BaseModel):
    id: UUID
    round_id: UUID
    market_id: Optional[UUID] = None
    amount: int
    potential_payout: int
    status: str  # pending | won | lost | cancelled
    placed_at: datetime
    resolved_at: Optional[datetime] = None


class PlaceLiveBetRequest(BaseModel):
    round_id: UUID
    window_duration_sec: int = Field(..., ge=5, le=300)
    vehicle_class: Optional[str] = None  # None = all vehicles
    exact_count: int = Field(..., ge=0, le=999)
    amount: int = Field(..., gt=0)


class PlaceLiveBetResponse(BaseModel):
    bet_id: UUID
    status: str
    amount: int
    potential_payout: int
    window_end: datetime
    exact_count: int
    vehicle_class: Optional[str]
    placed_at: datetime
