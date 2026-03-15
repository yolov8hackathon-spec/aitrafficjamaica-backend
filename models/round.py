"""Pydantic schemas for round and market request/response payloads."""
from uuid import UUID
from datetime import datetime, timezone, timedelta
from typing import Any, Optional

from pydantic import BaseModel, Field, model_validator


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


# ── Guardrail constants ───────────────────────────────────────────────────────
MIN_DURATION_SEC   = 5 * 60        # 5 minutes
MAX_DURATION_SEC   = 8 * 3600      # 8 hours
MIN_ODDS           = 1.20          # floor to prevent near-free-money odds
MAX_SCHEDULE_AHEAD = timedelta(hours=24)

# For over_under: threshold must sit within this ratio of duration-minutes.
# Too low → guaranteed "over". Too high → impossible "over".
# Conservative Kingston traffic: ~2 vehicles/min minimum, ~20/min maximum.
THRESHOLD_MIN_PER_MIN = 0.5   # floor: threshold >= duration_min * 0.5
THRESHOLD_MAX_PER_MIN = 25.0  # ceiling: threshold <= duration_min * 25


class CreateRoundRequest(BaseModel):
    camera_id: UUID
    market_type: str = Field(..., pattern="^(over_under|vehicle_count|vehicle_type|custom)$")
    params: dict[str, Any]
    opens_at: datetime
    closes_at: datetime
    ends_at: datetime
    markets: list[dict[str, Any]] = Field(..., min_length=1)

    @model_validator(mode="after")
    def validate_round(self) -> "CreateRoundRequest":
        now = datetime.now(timezone.utc)

        # Make inputs tz-aware if naive
        opens  = self.opens_at.replace(tzinfo=timezone.utc)  if self.opens_at.tzinfo  is None else self.opens_at
        closes = self.closes_at.replace(tzinfo=timezone.utc) if self.closes_at.tzinfo is None else self.closes_at
        ends   = self.ends_at.replace(tzinfo=timezone.utc)   if self.ends_at.tzinfo   is None else self.ends_at

        # Schedule window
        if opens > now + MAX_SCHEDULE_AHEAD:
            raise ValueError("opens_at must be within 24 hours from now")

        # Duration
        duration_sec = (ends - opens).total_seconds()
        if duration_sec < MIN_DURATION_SEC:
            raise ValueError(
                f"Round duration is too short ({int(duration_sec/60)} min). Minimum is 5 minutes."
            )
        if duration_sec > MAX_DURATION_SEC:
            raise ValueError(
                f"Round duration is too long ({int(duration_sec/3600)}h). Maximum is 8 hours."
            )

        # Timing order
        if closes >= ends:
            raise ValueError("closes_at must be before ends_at")
        if closes <= opens:
            raise ValueError("closes_at must be after opens_at")

        # Odds floor on every market
        for m in self.markets:
            odds = float(m.get("odds", 0))
            if odds < MIN_ODDS:
                raise ValueError(
                    f"Market '{m.get('outcome_key', '?')}' has odds {odds:.2f}x — "
                    f"minimum is {MIN_ODDS}x to ensure competitive payout."
                )

        # Threshold sanity for over_under and vehicle_count
        if self.market_type in ("over_under", "vehicle_count"):
            threshold    = int(self.params.get("threshold", 0))
            duration_min = duration_sec / 60

            # vehicle_count uses a per-class rate multiplier (individual type is
            # a fraction of total traffic)
            CLASS_MULTIPLIERS = {
                "car": 0.50, "motorcycle": 0.20, "truck": 0.15, "bus": 0.10,
            }
            multiplier = 1.0
            if self.market_type == "vehicle_count":
                vehicle_class = self.params.get("vehicle_class", "")
                if vehicle_class not in CLASS_MULTIPLIERS:
                    raise ValueError(
                        "vehicle_class must be one of: car, truck, bus, motorcycle"
                    )
                multiplier = CLASS_MULTIPLIERS[vehicle_class]

            min_threshold = max(1, int(duration_min * THRESHOLD_MIN_PER_MIN * multiplier))
            max_threshold = max(5, int(duration_min * THRESHOLD_MAX_PER_MIN * multiplier))

            if threshold < 1:
                raise ValueError("Threshold must be at least 1.")
            if threshold < min_threshold:
                raise ValueError(
                    f"Threshold {threshold} is too low for this round "
                    f"(minimum {min_threshold}). Near-guaranteed win."
                )
            if threshold > max_threshold:
                raise ValueError(
                    f"Threshold {threshold} is too high for this round "
                    f"(maximum {max_threshold}). Nearly impossible."
                )

        return self


class ResolveRoundRequest(BaseModel):
    round_id: UUID
    result: dict[str, Any]  # {total, by_class}
