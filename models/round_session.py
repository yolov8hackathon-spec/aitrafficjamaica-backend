"""Pydantic schemas for automated round session loops."""

from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


class CreateRoundSessionRequest(BaseModel):
    camera_id: UUID
    market_type: str = Field(..., pattern="^(over_under|vehicle_count|vehicle_type)$")
    threshold: Optional[int] = Field(default=None, ge=1)
    vehicle_class: Optional[str] = None
    round_duration_min: int = Field(..., ge=5, le=480)
    bet_cutoff_min: int = Field(..., ge=0, le=120)
    interval_min: int = Field(..., ge=0, le=120)
    session_duration_min: int = Field(..., ge=10, le=24 * 60)
    max_rounds: Optional[int] = Field(default=None, ge=1, le=500)


class RoundSessionOut(BaseModel):
    id: UUID
    camera_id: UUID
    status: str
    market_type: str
    threshold: Optional[int] = None
    vehicle_class: Optional[str] = None
    round_duration_min: int
    bet_cutoff_min: int
    interval_min: int
    session_duration_min: int
    max_rounds: Optional[int] = None
    created_rounds: int
    starts_at: datetime
    ends_at: datetime
    next_round_at: Optional[datetime] = None
    created_at: datetime

