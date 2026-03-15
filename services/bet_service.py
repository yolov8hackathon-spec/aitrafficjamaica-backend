"""
bet_service.py — Atomic bet placement (market bets + exact-count live bets).
"""
import logging
import threading
from uuid import UUID
from datetime import datetime, timezone, timedelta

from fastapi import HTTPException
from supabase_client import get_supabase
from models.bet import PlaceBetRequest, PlaceBetResponse, PlaceLiveBetRequest, PlaceLiveBetResponse
from ai.live_state import get_live_snapshot

logger = logging.getLogger(__name__)

INITIAL_BALANCE = 1000
LIVE_BET_ODDS = 8.0  # fixed 8x for exact-count micro-bets
MAX_PENDING_BETS_PER_ROUND = 2
_validation_metrics_lock = threading.Lock()
_validation_metrics = {
    "accepted_total": 0,
    "rejected_total": 0,
    "reasons": {},
    "last_event_at": None,
}


def _record_validation_event(accepted: bool, reason: str | None = None) -> None:
    now = datetime.now(timezone.utc).isoformat()
    with _validation_metrics_lock:
        if accepted:
            _validation_metrics["accepted_total"] += 1
        else:
            _validation_metrics["rejected_total"] += 1
            key = str(reason or "validation_rejected").strip()[:160]
            reasons = _validation_metrics["reasons"]
            reasons[key] = int(reasons.get(key, 0)) + 1
        _validation_metrics["last_event_at"] = now


def get_bet_validation_status() -> dict:
    with _validation_metrics_lock:
        accepted = int(_validation_metrics["accepted_total"])
        rejected = int(_validation_metrics["rejected_total"])
        total = accepted + rejected
        reasons = dict(_validation_metrics["reasons"])
        return {
            "accepted_total": accepted,
            "rejected_total": rejected,
            "total_evaluated": total,
            "reject_rate": (rejected / total) if total else 0.0,
            "reasons": dict(sorted(reasons.items(), key=lambda item: item[1], reverse=True)),
            "last_event_at": _validation_metrics["last_event_at"],
        }


def _as_actionable_db_error(exc: Exception) -> HTTPException:
    msg = str(exc)
    low = msg.lower()
    if ("column" in low and "does not exist" in low) or ("null value in column \"market_id\"" in low):
        return HTTPException(
            status_code=500,
            detail=(
                "Database schema is out of date for betting. "
                "Run latest supabase/schema.sql migration (bets columns + nullable market_id)."
            ),
        )
    return HTTPException(status_code=500, detail="Bet placement failed due to database error")


def _parse_round_closes_at(rnd: dict) -> datetime:
    raw = rnd.get("closes_at")
    if not raw:
        raise HTTPException(status_code=400, detail="Round timing is misconfigured (missing closes_at)")
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except Exception:
        raise HTTPException(status_code=400, detail="Round timing is invalid (bad closes_at format)")


def _parse_round_ends_at(rnd: dict) -> datetime:
    raw = rnd.get("ends_at")
    if not raw:
        raise HTTPException(status_code=400, detail="Round timing is misconfigured (missing ends_at)")
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except Exception:
        raise HTTPException(status_code=400, detail="Round timing is invalid (bad ends_at format)")


def _extract_bet_id_from_rpc_data(data) -> str:
    """
    Supabase RPC payloads can vary by client version.
    Accept common shapes and fail with a clear error if unknown.
    """
    # {"bet_id": "..."}
    if isinstance(data, dict):
        if data.get("bet_id"):
            return str(data["bet_id"])
        # {"place_bet_atomic": {"bet_id": "..."}}
        inner = data.get("place_bet_atomic")
        if isinstance(inner, dict) and inner.get("bet_id"):
            return str(inner["bet_id"])

    # [{"bet_id": "..."}] or [{"place_bet_atomic": {"bet_id":"..."}}]
    if isinstance(data, list) and data:
        row = data[0]
        if isinstance(row, dict):
            if row.get("bet_id"):
                return str(row["bet_id"])
            inner = row.get("place_bet_atomic")
            if isinstance(inner, dict) and inner.get("bet_id"):
                return str(inner["bet_id"])

    raise HTTPException(
        status_code=500,
        detail=f"Unexpected RPC response format from place_bet_atomic: {type(data).__name__}",
    )


async def _pending_bets_for_round(sb, user_id: str, round_id: str) -> int:
    # `head=True` is not supported on some supabase-py versions.
    # Use a compatible query and count rows client-side.
    resp = await (
        sb.table("bets")
        .select("id")
        .eq("user_id", user_id)
        .eq("round_id", round_id)
        .eq("status", "pending")
        .execute()
    )
    return len(resp.data or [])


async def _assert_user_can_stake(sb, user_id: str, amount: int) -> None:
    try:
        bal_resp = await sb.rpc("get_user_balance", {"p_user_id": user_id}).execute()
        balance = int(bal_resp.data if bal_resp.data is not None else INITIAL_BALANCE)
    except Exception:
        # If balance precheck fails, keep existing atomic guard in place.
        return
    if balance < amount:
        raise HTTPException(status_code=400, detail="Insufficient balance")


async def _get_snapshot_baseline_at_or_before(
    sb,
    camera_id: str | None,
    at_iso: str | None,
    market_type: str,
    vehicle_class: str | None = None,
) -> int:
    """
    Resolve baseline from snapshot nearest to a placement/open timestamp.
    Priority:
      1. Live in-memory counter (most accurate — zero latency gap)
      2. Latest non-zero snapshot <= timestamp
      3. Latest non-zero snapshot >= timestamp
      4. Latest non-zero snapshot for camera
      5. Any latest non-zero snapshot

    Skips zero-total rows so a bad redeploy snapshot can't zero-out the baseline.
    """
    if not camera_id:
        return 0

    def _extract_snap(row: dict | None) -> int:
        if not row:
            return 0
        if market_type == "vehicle_count":
            if not vehicle_class:
                return 0
            return int((row.get("vehicle_breakdown") or {}).get(vehicle_class, 0) or 0)
        return int(row.get("total", 0) or 0)

    # 1. Live counter — exact count with zero timing gap.
    live_snap = get_live_snapshot()
    live_val = 0
    if live_snap:
        live_val = _extract_snap(live_snap)

    try:
        if at_iso:
            before = await (
                sb.table("count_snapshots")
                .select("total, vehicle_breakdown")
                .eq("camera_id", camera_id)
                .gt("total", 0)
                .lte("captured_at", at_iso)
                .order("captured_at", desc=True)
                .limit(1)
                .execute()
            )
            if before.data:
                return max(live_val, _extract_snap(before.data[0]))

            after = await (
                sb.table("count_snapshots")
                .select("total, vehicle_breakdown")
                .eq("camera_id", camera_id)
                .gt("total", 0)
                .gte("captured_at", at_iso)
                .order("captured_at", desc=False)
                .limit(1)
                .execute()
            )
            if after.data:
                return max(live_val, _extract_snap(after.data[0]))

        if live_val > 0:
            return live_val

        latest = await (
            sb.table("count_snapshots")
            .select("total, vehicle_breakdown")
            .eq("camera_id", camera_id)
            .gt("total", 0)
            .order("captured_at", desc=True)
            .limit(1)
            .execute()
        )
        if latest.data:
            return _extract_snap(latest.data[0])

        # Final fallback when camera mapping is stale/missing snapshots.
        any_latest = await (
            sb.table("count_snapshots")
            .select("total, vehicle_breakdown")
            .gt("total", 0)
            .order("captured_at", desc=True)
            .limit(1)
            .execute()
        )
        if any_latest.data:
            return _extract_snap(any_latest.data[0])
    except Exception:
        return live_val
    return live_val


async def _get_round_start_baseline(sb, rnd: dict, market_type: str, params: dict | None) -> int:
    """
    Resolve a round-local baseline from the snapshot at/before round open time.
    This prevents inheriting pre-round cumulative totals when placement snapshots are sparse.
    """
    camera_id = rnd.get("camera_id")
    opens_at = rnd.get("opens_at")
    cls = (params or {}).get("vehicle_class")

    # Prefer persisted round baseline captured when round opened.
    round_params = rnd.get("params") or {}
    if market_type == "vehicle_count":
        by_class = round_params.get("round_baseline_by_class") or {}
        persisted = int(by_class.get(cls, 0) or 0) if cls else 0
    else:
        persisted = int(round_params.get("round_baseline_total", 0) or 0)
    if persisted > 0:
        return persisted

    if not camera_id or not opens_at:
        return 0
    try:
        snap_resp = await (
            sb.table("count_snapshots")
            .select("total, vehicle_breakdown")
            .eq("camera_id", camera_id)
            .lte("captured_at", opens_at)
            .order("captured_at", desc=True)
            .limit(1)
            .execute()
        )
        if snap_resp.data:
            snap = snap_resp.data[0]
        else:
            snap_after = await (
                sb.table("count_snapshots")
                .select("total, vehicle_breakdown")
                .eq("camera_id", camera_id)
                .gte("captured_at", opens_at)
                .order("captured_at", desc=False)
                .limit(1)
                .execute()
            )
            if not snap_after.data:
                return 0
            snap = snap_after.data[0]
        if market_type == "vehicle_count":
            if not cls:
                return 0
            return int((snap.get("vehicle_breakdown") or {}).get(cls, 0) or 0)
        return int(snap.get("total", 0) or 0)
    except Exception:
        return 0


async def place_bet(user_id: str, req: PlaceBetRequest) -> PlaceBetResponse:
    """
    Atomically place a market bet:
    1. Verify the round is still open
    2. Verify the market belongs to the round
    3. Fetch current user balance
    4. Check sufficient funds
    5. Deduct balance + insert bet in one RPC call
    """
    sb = await get_supabase()
    try:
        try:
            round_resp = await sb.table("bet_rounds").select("*").eq("id", str(req.round_id)).single().execute()
            if not round_resp.data:
                raise HTTPException(status_code=404, detail="Round not found")
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(status_code=404, detail="Round not found")

        rnd = round_resp.data
        now = datetime.now(timezone.utc)

        if rnd["status"] != "open":
            raise HTTPException(status_code=400, detail=f"Round is {rnd['status']}, bets not accepted")

        closes_at = _parse_round_closes_at(rnd)
        if now >= closes_at:
            raise HTTPException(status_code=403, detail="Betting window has closed")

        pending = await _pending_bets_for_round(sb, user_id, str(req.round_id))
        if pending >= MAX_PENDING_BETS_PER_ROUND:
            raise HTTPException(
                status_code=429,
                detail=f"Maximum {MAX_PENDING_BETS_PER_ROUND} active bets per round reached",
            )
        await _assert_user_can_stake(sb, user_id, req.amount)

        try:
            mkt_resp = await (
                sb.table("markets")
                .select("*")
                .eq("id", str(req.market_id))
                .eq("round_id", str(req.round_id))
                .single()
                .execute()
            )
            if not mkt_resp.data:
                raise HTTPException(status_code=404, detail="Market not found in this round")
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(status_code=404, detail="Market not found in this round")

        market = mkt_resp.data
        odds = float(market["odds"])
        potential_payout = int(req.amount * odds)

        try:
            rpc_resp = await sb.rpc("place_bet_atomic", {
                "p_user_id": user_id,
                "p_round_id": str(req.round_id),
                "p_market_id": str(req.market_id),
                "p_amount": req.amount,
                "p_potential_payout": potential_payout,
            }).execute()
        except Exception as exc:
            msg = str(exc)
            low = msg.lower()
            if "insufficient balance" in low:
                raise HTTPException(status_code=400, detail="Insufficient balance")
            if "duplicate" in low or "unique" in low:
                raise HTTPException(status_code=400, detail="You already placed a bet on this market")
            raise _as_actionable_db_error(exc)

        if rpc_resp.data and isinstance(rpc_resp.data, dict) and rpc_resp.data.get("error"):
            raise HTTPException(status_code=400, detail=rpc_resp.data["error"])

        bet_id = _extract_bet_id_from_rpc_data(rpc_resp.data)
        # Anchor market bets to placement-time baseline so progress starts at 0 for the user.
        market_type = str(rnd.get("market_type") or "")
        params = rnd.get("params") or {}
        vehicle_class = str(params.get("vehicle_class") or "") if market_type == "vehicle_count" else None
        baseline_count = await _get_snapshot_baseline_at_or_before(
            sb,
            rnd.get("camera_id"),
            now.isoformat(),
            market_type,
            vehicle_class=vehicle_class,
        )
        if baseline_count <= 0:
            round_start_baseline = await _get_round_start_baseline(sb, rnd, market_type, params)
            baseline_count = int(round_start_baseline or 0)

        # Optional enrichment fields for newer schemas; ignore if columns do not exist.
        try:
            await (
                sb.table("bets")
                .update({"bet_type": "market", "baseline_count": baseline_count})
                .eq("id", str(bet_id))
                .execute()
            )
        except Exception as exc:
            logger.warning("Skipping optional bet enrichment columns for bet %s: %s", bet_id, exc)

        _record_validation_event(True)
        return PlaceBetResponse(
            bet_id=bet_id,
            status="pending",
            amount=req.amount,
            potential_payout=potential_payout,
            placed_at=datetime.now(timezone.utc),
        )
    except HTTPException as exc:
        if 400 <= int(exc.status_code) < 500:
            _record_validation_event(False, str(exc.detail))
        raise
    except Exception:
        logger.exception("Unhandled place_bet crash")   # full traceback to server logs only
        raise HTTPException(status_code=500, detail="Bet placement failed. Please try again.")


async def place_live_bet(user_id: str, req: PlaceLiveBetRequest) -> PlaceLiveBetResponse:
    """
    Place an exact-count micro-bet:
    1. Verify round is open and closes_at not passed
    2. Fetch baseline count from latest count_snapshot
    3. Deduct balance atomically
    4. Insert bet with bet_type='exact_count'
    Returns bet details including window_end time.
    """
    sb = await get_supabase()

    try:
        # 1. Validate round
        try:
            round_resp = await sb.table("bet_rounds").select("*").eq("id", str(req.round_id)).single().execute()
            if not round_resp.data:
                raise HTTPException(status_code=404, detail="Round not found")
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(status_code=404, detail="Round not found")

        rnd = round_resp.data
        now = datetime.now(timezone.utc)

        if rnd["status"] != "open":
            raise HTTPException(status_code=400, detail=f"Round is {rnd['status']}, bets not accepted")

        closes_at = _parse_round_closes_at(rnd)
        if now >= closes_at:
            raise HTTPException(status_code=403, detail="Betting window has closed")

        pending = await _pending_bets_for_round(sb, user_id, str(req.round_id))
        if pending >= MAX_PENDING_BETS_PER_ROUND:
            raise HTTPException(
                status_code=429,
                detail=f"Maximum {MAX_PENDING_BETS_PER_ROUND} active bets per round reached",
            )
        await _assert_user_can_stake(sb, user_id, req.amount)

        # Live bet window must fit in current round window.
        ends_at = _parse_round_ends_at(rnd)
        if now + timedelta(seconds=req.window_duration_sec) > ends_at:
            raise HTTPException(status_code=400, detail="Live bet window extends past round end")

        # 2. Validate vehicle_class
        valid_classes = {"car", "truck", "bus", "motorcycle"}
        if req.vehicle_class is not None and req.vehicle_class not in valid_classes:
            raise HTTPException(status_code=400, detail=f"Invalid vehicle_class: {req.vehicle_class}")

        # 3. Fetch baseline from snapshot nearest placement timestamp.
        camera_id = rnd.get("camera_id")
        baseline_count = await _get_snapshot_baseline_at_or_before(
            sb,
            camera_id,
            now.isoformat(),
            "vehicle_count" if req.vehicle_class else "over_under",
            vehicle_class=req.vehicle_class,
        )

        # 4. Check balance and deduct atomically
        potential_payout = int(req.amount * LIVE_BET_ODDS)

        # Route through existing DB atomic function so balance + insert stay in one transaction.
        try:
            rpc_resp = await sb.rpc("place_bet_atomic", {
                "p_user_id": user_id,
                "p_round_id": str(req.round_id),
                "p_market_id": None,
                "p_amount": req.amount,
                "p_potential_payout": potential_payout,
            }).execute()
        except Exception as exc:
            msg = str(exc).lower()
            if "insufficient balance" in msg:
                raise HTTPException(status_code=400, detail="Insufficient balance")
            raise _as_actionable_db_error(exc)

        if rpc_resp.data and isinstance(rpc_resp.data, dict) and rpc_resp.data.get("error"):
            raise HTTPException(status_code=400, detail=rpc_resp.data["error"])

        bet_id = _extract_bet_id_from_rpc_data(rpc_resp.data)

        # 5. Update inserted bet with live-bet specific metadata
        window_start = now
        window_end = now + timedelta(seconds=req.window_duration_sec)

        live_update = {
            "bet_type": "exact_count",
            "window_start": window_start.isoformat(),
            "window_duration_sec": req.window_duration_sec,
            "vehicle_class": req.vehicle_class,
            "exact_count": req.exact_count,
            "baseline_count": baseline_count,
        }

        try:
            await sb.table("bets").update(live_update).eq("id", str(bet_id)).execute()
        except Exception as exc:
            raise _as_actionable_db_error(exc)

        _record_validation_event(True)
        return PlaceLiveBetResponse(
            bet_id=bet_id,
            status="pending",
            amount=req.amount,
            potential_payout=potential_payout,
            window_end=window_end,
            exact_count=req.exact_count,
            vehicle_class=req.vehicle_class,
            placed_at=window_start,
        )
    except HTTPException as exc:
        if 400 <= int(exc.status_code) < 500:
            _record_validation_event(False, str(exc.detail))
        raise


async def get_user_balance(user_id: str) -> int:
    """Read user balance. Falls back to INITIAL_BALANCE if no record found."""
    sb = await get_supabase()
    resp = await sb.rpc("get_user_balance", {"p_user_id": user_id}).execute()
    if resp.data is not None:
        return int(resp.data)
    return INITIAL_BALANCE
