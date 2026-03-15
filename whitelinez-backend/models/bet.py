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
    market_id: UUID
    amount: int
    potential_payout: int
    status: str  # pending | won | lost | cancelled
    placed_at: datetime
    resolved_at: Optional[datetime] = None
