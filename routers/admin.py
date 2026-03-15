"""
routers/admin.py — Admin-only round management endpoints.
POST /admin/rounds     → create a new round + markets
POST /admin/resolve    → manually resolve a round
POST /admin/set-role   → grant/revoke admin role on a user
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from pydantic import BaseModel

from models.round import CreateRoundRequest, ResolveRoundRequest, RoundOut
from models.round_session import CreateRoundSessionRequest
from services.auth_service import validate_supabase_jwt, require_admin, get_user_id
from services.round_service import create_round, resolve_round, resolve_round_from_latest_snapshot
from services.round_session_service import create_round_session, list_round_sessions, stop_round_session
from services.ml_pipeline_service import auto_retrain_cycle, list_jobs, list_models, get_ml_diagnostics
from services.ml_capture_monitor import get_capture_status, set_capture_paused, is_capture_paused, record_capture_event
from services.runtime_tuner import RUNTIME_PROFILES
from services.bet_service import get_bet_validation_status
from config import get_config
from supabase_client import get_supabase
from websocket.ws_manager import manager
from middleware.rate_limiter import limiter
from ai.url_refresher import trigger_force_refresh

router = APIRouter(prefix="/admin", tags=["admin"])
logger = logging.getLogger(__name__)


async def _require_admin_user(authorization: Annotated[str | None, Header()] = None) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing Bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    payload = await validate_supabase_jwt(token)
    require_admin(payload)
    return payload


def _default_capture_dataset_yaml_url(cfg) -> str:
    base = str(getattr(cfg, "SUPABASE_URL", "") or "").rstrip("/")
    bucket = str(getattr(cfg, "AUTO_CAPTURE_UPLOAD_BUCKET", "") or "ml-datasets").strip("/")
    prefix = str(getattr(cfg, "AUTO_CAPTURE_UPLOAD_PREFIX", "") or "datasets/live-capture").strip("/")
    if not base:
        return ""
    return f"{base}/storage/v1/object/public/{bucket}/{prefix}/data.yaml"


@router.post("/rounds", response_model=RoundOut, status_code=201)
async def admin_create_round(
    body: CreateRoundRequest,
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    try:
        return await create_round(body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/resolve")
async def admin_resolve_round(
    body: ResolveRoundRequest,
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    await resolve_round(str(body.round_id), body.result)
    return {"message": "Round resolved", "round_id": str(body.round_id)}


@router.patch("/rounds")
async def admin_resolve_round_latest(
    body: dict,  # {"round_id": "..."}
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    """
    Manual override resolve:
    - Resolves the given round from latest snapshot result.
    - Works even when auto-resolve is enabled.
    """
    round_id = body.get("round_id")
    if not round_id:
        raise HTTPException(status_code=400, detail="round_id required")

    result = await resolve_round_from_latest_snapshot(str(round_id))
    return {"message": "Round resolved", "round_id": str(round_id), "result": result}


@router.post("/round-sessions", status_code=201)
async def admin_create_round_session(
    body: CreateRoundSessionRequest,
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    return await create_round_session(body)


@router.get("/round-sessions")
async def admin_list_round_sessions(
    admin: Annotated[dict, Depends(_require_admin_user)],
    limit: int = Query(default=50, ge=1, le=200),
):
    return {"sessions": await list_round_sessions(limit=limit)}


@router.patch("/round-sessions/{session_id}/stop")
async def admin_stop_round_session(
    session_id: str,
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    data = await stop_round_session(session_id)
    return {"session": data}


@router.get("/bets")
async def admin_list_bets(
    admin: Annotated[dict, Depends(_require_admin_user)],
    limit: int = Query(default=200, ge=1, le=1000),
):
    """
    Admin read-only feed of recent bets with bettor identity.
    Uses profiles.username when available, otherwise falls back to user_id.
    """
    sb = await get_supabase()

    bets_resp = await (
        sb.table("bets")
        .select(
            "id,user_id,round_id,market_id,amount,potential_payout,status,bet_type,"
            "vehicle_class,exact_count,actual_count,baseline_count,window_start,window_duration_sec,placed_at,resolved_at,"
            "markets(label,odds),bet_rounds(market_type,status)"
        )
        .order("placed_at", desc=True)
        .limit(limit)
        .execute()
    )
    bets = bets_resp.data or []

    user_ids = sorted({b.get("user_id") for b in bets if b.get("user_id")})
    profile_map: dict[str, str] = {}
    if user_ids:
        try:
            prof_resp = await (
                sb.table("profiles")
                .select("user_id,username")
                .in_("user_id", user_ids)
                .execute()
            )
            for p in (prof_resp.data or []):
                uid = p.get("user_id")
                uname = p.get("username")
                if uid and uname:
                    profile_map[str(uid)] = str(uname)
        except Exception:
            # profiles table may be absent in older installs
            pass

    enriched = []
    for b in bets:
        uid = str(b.get("user_id") or "")
        b["username"] = profile_map.get(uid)
        enriched.append(b)

    return {"bets": enriched}


@router.get("/bets/validation-status")
async def admin_bet_validation_status(
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    """
    Runtime validation metrics for bet placement outcomes.
    """
    return get_bet_validation_status()


@router.get("/active-users")
async def admin_active_users(
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    """
    Live websocket presence + DB-backed audience telemetry for admin dashboard.
    """
    snapshot = manager.connection_snapshot()
    snapshot["db"] = await _load_db_audience_snapshot()
    return snapshot


async def _load_db_audience_snapshot() -> dict:
    sb = await get_supabase()
    now = datetime.now(timezone.utc)
    since_24h = (now - timedelta(hours=24)).isoformat()

    result: dict = {
        "registered_users_total": 0,
        "registered_users_recent": [],
        "guests_total": 0,
        "guests_24h": 0,
        "guest_recent": [],
        "site_views_total": 0,
        "site_views_24h": 0,
        "site_views_recent": [],
        "site_views_top_pages_24h": [],
    }

    # Registered users from profiles table (DB truth).
    try:
        prof_count = await (
            sb.table("profiles")
            .select("user_id", count="exact", head=True)
            .execute()
        )
        result["registered_users_total"] = int(prof_count.count or 0)
    except Exception:
        pass

    try:
        prof_recent = await (
            sb.table("profiles")
            .select("user_id,username,created_at,updated_at")
            .order("updated_at", desc=True)
            .limit(30)
            .execute()
        )
        result["registered_users_recent"] = prof_recent.data or []
    except Exception:
        pass

    # Guest visitors from site_views (DB truth — all site visitors, not just chatters).
    try:
        sv_guest_resp = await (
            sb.table("site_views")
            .select("guest_id,viewed_at,page_path,referrer")
            .not_.is_("guest_id", "null")
            .order("viewed_at", desc=True)
            .limit(2000)
            .execute()
        )
        sv_guest_rows = sv_guest_resp.data or []
        guest_map: dict[str, dict] = {}
        guests_24h_set: set[str] = set()
        for row in sv_guest_rows:
            gid = str(row.get("guest_id") or "").strip()
            if not gid:
                continue
            viewed_at = str(row.get("viewed_at") or "")
            if gid not in guest_map:
                guest_map[gid] = {
                    "guest_id": gid,
                    "last_seen": viewed_at,
                    "page_path": row.get("page_path") or "/",
                    "visits": 0,
                }
            guest_map[gid]["visits"] += 1
            if viewed_at and viewed_at >= since_24h:
                guests_24h_set.add(gid)

        guests_sorted = sorted(
            guest_map.values(),
            key=lambda g: str(g.get("last_seen") or ""),
            reverse=True,
        )
        result["guests_total"] = len(guest_map)
        result["guests_24h"] = len(guests_24h_set)
        result["guest_recent"] = guests_sorted[:30]
    except Exception:
        pass

    # Site views history (DB).
    try:
        sv_count = await (
            sb.table("site_views")
            .select("id", count="exact", head=True)
            .execute()
        )
        result["site_views_total"] = int(sv_count.count or 0)
    except Exception:
        pass

    try:
        sv_rows_resp = await (
            sb.table("site_views")
            .select("user_id,guest_id,page_path,referrer,viewed_at,source")
            .order("viewed_at", desc=True)
            .limit(1200)
            .execute()
        )
        sv_rows = sv_rows_resp.data or []
        result["site_views_recent"] = sv_rows[:40]

        recent_24h = [r for r in sv_rows if str(r.get("viewed_at") or "") >= since_24h]
        result["site_views_24h"] = len(recent_24h)

        page_counts: dict[str, int] = {}
        for row in recent_24h:
            page = str(row.get("page_path") or "/").strip() or "/"
            page_counts[page] = page_counts.get(page, 0) + 1
        result["site_views_top_pages_24h"] = [
            {"page_path": page, "views": count}
            for page, count in sorted(page_counts.items(), key=lambda kv: kv[1], reverse=True)[:12]
        ]
    except Exception:
        pass

    return result


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

    _audit(admin, "set_user_role", f"target={target_user_id} role={role}")
    sb = await get_supabase()
    # Supabase admin SDK: update user metadata
    await sb.auth.admin.update_user_by_id(
        target_user_id,
        {"app_metadata": {"role": role}},
    )
    return {"message": f"User {target_user_id} role set to {role}"}


@router.get("/users")
async def admin_list_users(
    admin: Annotated[dict, Depends(_require_admin_user)],
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=50, ge=1, le=200),
):
    """
    List registered users (admin-only) with auth info + betting summary.
    """
    sb = await get_supabase()

    # supabase-py signatures vary by version; support both call styles.
    try:
        resp = await sb.auth.admin.list_users(page=page, per_page=per_page)
    except TypeError:
        resp = await sb.auth.admin.list_users({"page": page, "per_page": per_page})

    # list_users response shape differs across SDK versions:
    # - resp.users
    # - {"users": [...]}
    # - {"data": {"users": [...]}}
    # - model_dump() with one of the above
    payload = None
    if hasattr(resp, "model_dump"):
        payload = resp.model_dump() or {}
    elif isinstance(resp, dict):
        payload = resp
    else:
        payload = {}

    users_raw = (
        getattr(resp, "users", None)
        or payload.get("users")
        or (payload.get("data") or {}).get("users")
        or getattr(resp, "data", {}).get("users") if hasattr(resp, "data") else None
    )
    users_raw = users_raw or []

    users = []
    for u in users_raw:
        if hasattr(u, "model_dump"):
            rec = u.model_dump()
        elif isinstance(u, dict):
            rec = u
        else:
            rec = {}
        app_meta = rec.get("app_metadata") or {}
        raw_meta = rec.get("user_metadata") or rec.get("raw_user_meta_data") or {}
        identities = rec.get("identities") or []
        identity_email = None
        for ident in identities:
            if not isinstance(ident, dict):
                continue
            id_data = ident.get("identity_data") or {}
            if isinstance(id_data, dict) and id_data.get("email"):
                identity_email = id_data.get("email")
                break
        users.append(
            {
                "id": rec.get("id"),
                "email": rec.get("email") or raw_meta.get("email") or identity_email,
                "created_at": rec.get("created_at"),
                "last_sign_in_at": rec.get("last_sign_in_at") or rec.get("updated_at"),
                "role": app_meta.get("role", "user"),
                "email_confirmed_at": rec.get("email_confirmed_at"),
                "username": raw_meta.get("username"),
            }
        )

    # Fallback: if auth admin list is empty but profiles exist, surface those users.
    # This helps when auth list shape/permissions differ but app users are present.
    if not users:
        try:
            prof_resp = await (
                sb.table("profiles")
                .select("user_id,username,created_at,updated_at")
                .order("created_at", desc=True)
                .limit(per_page)
                .execute()
            )
            for p in (prof_resp.data or []):
                uid = p.get("user_id")
                if not uid:
                    continue
                users.append(
                    {
                        "id": uid,
                        "email": None,
                        "created_at": p.get("created_at"),
                        "last_sign_in_at": p.get("updated_at") or p.get("created_at"),
                        "role": "user",
                        "email_confirmed_at": None,
                        "username": p.get("username"),
                    }
                )
        except Exception:
            pass

    # Enrich from profiles + bets so admin can see user activity at a glance.
    user_ids = [str(u.get("id")) for u in users if u.get("id")]
    profile_map: dict[str, dict] = {}
    bet_summary_map: dict[str, dict] = {}

    if user_ids:
        try:
            prof_resp = await (
                sb.table("profiles")
                .select("user_id,username,avatar_url,created_at,updated_at")
                .in_("user_id", user_ids)
                .execute()
            )
            for p in (prof_resp.data or []):
                uid = p.get("user_id")
                if uid:
                    profile_map[str(uid)] = p
        except Exception:
            pass

        try:
            bets_resp = await (
                sb.table("bets")
                .select(
                    "user_id,amount,status,placed_at,bet_type,vehicle_class,exact_count,"
                    "markets(label)"
                )
                .in_("user_id", user_ids)
                .order("placed_at", desc=True)
                .limit(5000)
                .execute()
            )
            for b in (bets_resp.data or []):
                uid = b.get("user_id")
                if not uid:
                    continue
                key = str(uid)
                if key not in bet_summary_map:
                    bet_summary_map[key] = {
                        "bet_count": 0,
                        "total_staked": 0,
                        "pending_count": 0,
                        "won_count": 0,
                        "lost_count": 0,
                        "last_bet_at": None,
                        "last_bet_status": None,
                        "last_bet_amount": 0,
                        "last_bet_label": None,
                    }
                s = bet_summary_map[key]
                amount = int(b.get("amount") or 0)
                status = str(b.get("status") or "pending")
                s["bet_count"] += 1
                s["total_staked"] += amount
                if status == "won":
                    s["won_count"] += 1
                elif status == "lost":
                    s["lost_count"] += 1
                else:
                    s["pending_count"] += 1

                # First item is most recent due to desc ordering.
                if not s["last_bet_at"]:
                    bet_type = str(b.get("bet_type") or "market")
                    market = b.get("markets") or {}
                    market_label = market.get("label") if isinstance(market, dict) else None
                    if bet_type == "exact_count":
                        cls = b.get("vehicle_class") or "vehicles"
                        label = f"Exact {b.get('exact_count') or 0} {cls}"
                    else:
                        label = market_label or "Market bet"
                    s["last_bet_at"] = b.get("placed_at")
                    s["last_bet_status"] = status
                    s["last_bet_amount"] = amount
                    s["last_bet_label"] = label
        except Exception:
            pass

    for u in users:
        uid = str(u.get("id") or "")
        p = profile_map.get(uid) or {}
        # Prefer auth username, then profile username.
        u["username"] = u.get("username") or p.get("username")
        u["avatar_url"] = p.get("avatar_url")
        if not u.get("created_at"):
            u["created_at"] = p.get("created_at")
        if not u.get("last_sign_in_at"):
            u["last_sign_in_at"] = p.get("updated_at") or p.get("created_at")
        u["bet_summary"] = bet_summary_map.get(uid) or {
            "bet_count": 0,
            "total_staked": 0,
            "pending_count": 0,
            "won_count": 0,
            "lost_count": 0,
            "last_bet_at": None,
            "last_bet_status": None,
            "last_bet_amount": 0,
            "last_bet_label": None,
        }

    return {"users": users, "page": page, "per_page": per_page}


@router.post("/ml/retrain")
async def admin_ml_retrain(
    body: dict,
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    """
    Manual ML retrain trigger.
    Optional body overrides:
    - hours
    - min_rows
    - min_score_gain
    """
    cfg = get_config()
    hours = int(body.get("hours", cfg.ML_AUTO_RETRAIN_HOURS))
    min_rows = int(body.get("min_rows", cfg.ML_AUTO_RETRAIN_MIN_ROWS))
    min_score_gain = float(body.get("min_score_gain", cfg.ML_AUTO_RETRAIN_MIN_SCORE_GAIN))

    dataset_yaml_url = str(body.get("dataset_yaml_url") or cfg.TRAINER_DATASET_YAML_URL).strip()
    if not dataset_yaml_url:
        raise HTTPException(
            status_code=400,
            detail="dataset_yaml_url is required. Set TRAINER_DATASET_YAML_URL or pass it in request body.",
        )
    epochs = int(body.get("epochs", cfg.TRAINER_EPOCHS))
    imgsz = int(body.get("imgsz", cfg.TRAINER_IMGSZ))
    batch = int(body.get("batch", cfg.TRAINER_BATCH))

    _audit(admin, "ml_retrain", f"hours={hours} min_rows={min_rows}")
    result = await auto_retrain_cycle(
        hours=hours,
        min_rows=min_rows,
        min_score_gain=min_score_gain,
        base_model=cfg.YOLO_MODEL,
        provider="webhook",
        params={
            "trainer_webhook_url": cfg.TRAINER_WEBHOOK_URL,
            "trainer_webhook_secret": cfg.TRAINER_WEBHOOK_SECRET,
            "dataset_yaml_url": dataset_yaml_url,
            "epochs": epochs,
            "imgsz": imgsz,
            "batch": batch,
        },
    )
    return result


@router.post("/ml/retrain-async")
async def admin_ml_retrain_async(
    body: dict,
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    """
    Queue retraining in background and return immediately.
    Prevents frontend/serverless timeout while long training is running.
    """
    cfg = get_config()
    hours = int(body.get("hours", cfg.ML_AUTO_RETRAIN_HOURS))
    min_rows = int(body.get("min_rows", cfg.ML_AUTO_RETRAIN_MIN_ROWS))
    min_score_gain = float(body.get("min_score_gain", cfg.ML_AUTO_RETRAIN_MIN_SCORE_GAIN))

    dataset_yaml_url = str(body.get("dataset_yaml_url") or cfg.TRAINER_DATASET_YAML_URL).strip()
    if not dataset_yaml_url:
        raise HTTPException(
            status_code=400,
            detail="dataset_yaml_url is required. Set TRAINER_DATASET_YAML_URL or pass it in request body.",
        )
    epochs = int(body.get("epochs", cfg.TRAINER_EPOCHS))
    imgsz = int(body.get("imgsz", cfg.TRAINER_IMGSZ))
    batch = int(body.get("batch", cfg.TRAINER_BATCH))

    async def _run():
        try:
            await auto_retrain_cycle(
                hours=hours,
                min_rows=min_rows,
                min_score_gain=min_score_gain,
                base_model=cfg.YOLO_MODEL,
                provider="webhook",
                params={
                    "trainer_webhook_url": cfg.TRAINER_WEBHOOK_URL,
                    "trainer_webhook_secret": cfg.TRAINER_WEBHOOK_SECRET,
                    "dataset_yaml_url": dataset_yaml_url,
                    "epochs": epochs,
                    "imgsz": imgsz,
                    "batch": batch,
                },
            )
        except Exception:
            # Failure details are captured in ml_training_jobs by pipeline service.
            return

    asyncio.create_task(_run())
    return {"message": "Retrain queued. Check Latest Jobs for progress."}


@router.post("/ml/train-captures-async")
async def admin_ml_train_captures_async(
    body: dict,
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    """
    Queue training specifically for the live-capture dataset path.
    Uses AUTO_CAPTURE_UPLOAD_BUCKET/AUTO_CAPTURE_UPLOAD_PREFIX by default.
    """
    cfg = get_config()
    hours = int(body.get("hours", cfg.ML_AUTO_RETRAIN_HOURS))
    min_rows = int(body.get("min_rows", cfg.ML_AUTO_RETRAIN_MIN_ROWS))
    min_score_gain = float(body.get("min_score_gain", cfg.ML_AUTO_RETRAIN_MIN_SCORE_GAIN))

    default_capture_yaml = _default_capture_dataset_yaml_url(cfg)
    dataset_yaml_url = str(
        body.get("capture_dataset_yaml_url")
        or body.get("dataset_yaml_url")
        or default_capture_yaml
    ).strip()
    if not dataset_yaml_url:
        raise HTTPException(
            status_code=400,
            detail="capture dataset_yaml_url is required. Configure AUTO_CAPTURE_UPLOAD_* or pass capture_dataset_yaml_url.",
        )
    epochs = int(body.get("epochs", cfg.TRAINER_EPOCHS))
    imgsz = int(body.get("imgsz", cfg.TRAINER_IMGSZ))
    batch = int(body.get("batch", cfg.TRAINER_BATCH))

    async def _run():
        try:
            await auto_retrain_cycle(
                hours=hours,
                min_rows=min_rows,
                min_score_gain=min_score_gain,
                base_model=cfg.YOLO_MODEL,
                provider="webhook",
                params={
                    "trainer_webhook_url": cfg.TRAINER_WEBHOOK_URL,
                    "trainer_webhook_secret": cfg.TRAINER_WEBHOOK_SECRET,
                    "dataset_yaml_url": dataset_yaml_url,
                    "epochs": epochs,
                    "imgsz": imgsz,
                    "batch": batch,
                },
            )
        except Exception:
            return

    asyncio.create_task(_run())
    return {
        "message": "Live-capture training queued. Check Latest Jobs for progress.",
        "dataset_yaml_url": dataset_yaml_url,
    }


@router.get("/ml/jobs")
async def admin_ml_jobs(
    admin: Annotated[dict, Depends(_require_admin_user)],
    limit: int = Query(default=50, ge=1, le=500),
):
    return {"jobs": await list_jobs(limit=limit)}


@router.get("/ml/models")
async def admin_ml_models(
    admin: Annotated[dict, Depends(_require_admin_user)],
    limit: int = Query(default=50, ge=1, le=500),
):
    return {"models": await list_models(limit=limit)}


@router.get("/ml/capture-status")
async def admin_ml_capture_status(
    admin: Annotated[dict, Depends(_require_admin_user)],
    limit: int = Query(default=50, ge=1, le=200),
):
    cfg = get_config()
    status = get_capture_status(limit=limit)
    return {
        "capture_enabled": cfg.AUTO_CAPTURE_ENABLED == 1,
        "upload_enabled": cfg.AUTO_CAPTURE_UPLOAD_ENABLED == 1,
        "capture_classes": [c.strip() for c in cfg.AUTO_CAPTURE_CLASSES.split(",") if c.strip()],
        "capture_paused": is_capture_paused(),
        **status,
    }


@router.patch("/ml/capture-status")
async def admin_ml_capture_status_patch(
    body: dict,
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    paused = bool(body.get("paused"))
    new_state = set_capture_paused(paused)
    record_capture_event(
        "capture_paused" if new_state else "capture_resumed",
        "Live capture paused by admin" if new_state else "Live capture resumed by admin",
        {"by_user": get_user_id(admin)},
    )
    return {
        "ok": True,
        "capture_paused": new_state,
        "note": "Applied in-memory immediately. Persists until backend restart/redeploy.",
    }


@router.get("/ml/diagnostics")
async def admin_ml_diagnostics(
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    cfg = get_config()
    return await get_ml_diagnostics(cfg=cfg)


@router.post("/ml/one-click")
async def admin_ml_one_click(
    body: dict,
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    cfg = get_config()
    diagnostics = await get_ml_diagnostics(cfg=cfg)
    if not diagnostics.get("ready_for_one_click"):
        raise HTTPException(
            status_code=400,
            detail={
                "message": "One-click pipeline blocked by missing required setup",
                "diagnostics": diagnostics,
            },
        )

    hours = int(body.get("hours", cfg.ML_AUTO_RETRAIN_HOURS))
    min_rows = int(body.get("min_rows", cfg.ML_AUTO_RETRAIN_MIN_ROWS))
    min_score_gain = float(body.get("min_score_gain", cfg.ML_AUTO_RETRAIN_MIN_SCORE_GAIN))
    epochs = int(body.get("epochs", cfg.TRAINER_EPOCHS))
    imgsz = int(body.get("imgsz", cfg.TRAINER_IMGSZ))
    batch = int(body.get("batch", cfg.TRAINER_BATCH))
    dataset_yaml_url = str(body.get("dataset_yaml_url") or cfg.TRAINER_DATASET_YAML_URL).strip()

    async def _run():
        try:
            await auto_retrain_cycle(
                hours=hours,
                min_rows=min_rows,
                min_score_gain=min_score_gain,
                base_model=cfg.YOLO_MODEL,
                provider="webhook",
                params={
                    "trainer_webhook_url": cfg.TRAINER_WEBHOOK_URL,
                    "trainer_webhook_secret": cfg.TRAINER_WEBHOOK_SECRET,
                    "dataset_yaml_url": dataset_yaml_url,
                    "epochs": epochs,
                    "imgsz": imgsz,
                    "batch": batch,
                },
            )
        except Exception:
            # Failure details are captured in ml_training_jobs by pipeline service.
            return

    asyncio.create_task(_run())
    return {
        "message": "One-click model pipeline queued",
        "result": {"status": "queued"},
        "diagnostics": diagnostics,
    }


@router.get("/ml/night-profile")
async def admin_ml_night_profile_get(
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    cfg = get_config()
    return {
        "enabled": int(getattr(cfg, "NIGHT_PROFILE_ENABLED", 0) or 0) == 1,
        "start_hour": int(getattr(cfg, "NIGHT_PROFILE_START_HOUR", 18) or 18),
        "end_hour": int(getattr(cfg, "NIGHT_PROFILE_END_HOUR", 6) or 6),
        "yolo_conf": float(getattr(cfg, "NIGHT_YOLO_CONF", cfg.YOLO_CONF)),
        "infer_size": int(getattr(cfg, "NIGHT_DETECT_INFER_SIZE", cfg.DETECT_INFER_SIZE)),
        "iou": float(getattr(cfg, "NIGHT_DETECT_IOU", cfg.DETECT_IOU)),
        "max_det": int(getattr(cfg, "NIGHT_DETECT_MAX_DET", cfg.DETECT_MAX_DET)),
        "note": "Runtime settings only. Persist via environment variables for restart durability.",
    }


@router.patch("/ml/night-profile")
async def admin_ml_night_profile_patch(
    body: dict,
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    cfg = get_config()

    if "enabled" in body:
        cfg.NIGHT_PROFILE_ENABLED = 1 if bool(body.get("enabled")) else 0
    if "start_hour" in body:
        cfg.NIGHT_PROFILE_START_HOUR = int(body.get("start_hour")) % 24
    if "end_hour" in body:
        cfg.NIGHT_PROFILE_END_HOUR = int(body.get("end_hour")) % 24
    if "yolo_conf" in body:
        cfg.NIGHT_YOLO_CONF = max(0.01, min(0.99, float(body.get("yolo_conf"))))
    if "infer_size" in body:
        cfg.NIGHT_DETECT_INFER_SIZE = max(320, min(1280, int(body.get("infer_size"))))
    if "iou" in body:
        cfg.NIGHT_DETECT_IOU = max(0.05, min(0.95, float(body.get("iou"))))
    if "max_det" in body:
        cfg.NIGHT_DETECT_MAX_DET = max(10, min(500, int(body.get("max_det"))))

    return {
        "ok": True,
        "settings": {
            "enabled": int(getattr(cfg, "NIGHT_PROFILE_ENABLED", 0) or 0) == 1,
            "start_hour": int(getattr(cfg, "NIGHT_PROFILE_START_HOUR", 18) or 18),
            "end_hour": int(getattr(cfg, "NIGHT_PROFILE_END_HOUR", 6) or 6),
            "yolo_conf": float(getattr(cfg, "NIGHT_YOLO_CONF", cfg.YOLO_CONF)),
            "infer_size": int(getattr(cfg, "NIGHT_DETECT_INFER_SIZE", cfg.DETECT_INFER_SIZE)),
            "iou": float(getattr(cfg, "NIGHT_DETECT_IOU", cfg.DETECT_IOU)),
            "max_det": int(getattr(cfg, "NIGHT_DETECT_MAX_DET", cfg.DETECT_MAX_DET)),
        },
        "note": "Applied in-memory immediately. Set env vars to persist across restart/redeploy.",
    }


@router.get("/ml/runtime-profile")
async def admin_ml_runtime_profile_get(
    admin: Annotated[dict, Depends(_require_admin_user)],
    camera_id: str | None = Query(default=None),
):
    """
    Read adaptive runtime profile controls from cameras.count_settings.
    """
    cfg = get_config()
    sb = await get_supabase()
    cam_id = await _resolve_runtime_camera_id(sb, cfg, camera_id)
    cam_resp = await (
        sb.table("cameras")
        .select("id,name,count_settings")
        .eq("id", cam_id)
        .single()
        .execute()
    )
    row = cam_resp.data or {}
    settings = row.get("count_settings") or {}
    if not isinstance(settings, dict):
        settings = {}

    return {
        "camera_id": row.get("id"),
        "camera_name": row.get("name"),
        "mode": settings.get("runtime_profile_mode", "auto"),
        "manual_profile": settings.get("runtime_manual_profile", ""),
        "manual_until": settings.get("runtime_manual_until"),
        "auto_enabled": settings.get("runtime_auto_enabled", 1),
        "autotune_interval_sec": settings.get("runtime_autotune_interval_sec", 20),
        "profile_cooldown_sec": settings.get("runtime_profile_cooldown_sec", 600),
        "stream_grab_latest": settings.get("runtime_stream_grab_latest", None),
        "available_profiles": sorted(RUNTIME_PROFILES.keys()),
        "count_settings": settings,
    }


@router.patch("/ml/runtime-profile")
async def admin_ml_runtime_profile_patch(
    body: dict,
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    """
    Update adaptive runtime profile controls in cameras.count_settings.
    """
    cfg = get_config()
    sb = await get_supabase()
    cam_id = await _resolve_runtime_camera_id(sb, cfg, body.get("camera_id"))
    cam_resp = await (
        sb.table("cameras")
        .select("count_settings")
        .eq("id", cam_id)
        .single()
        .execute()
    )
    settings = (cam_resp.data or {}).get("count_settings") or {}
    if not isinstance(settings, dict):
        settings = {}

    if "mode" in body:
        mode = str(body.get("mode") or "auto").strip().lower()
        if mode not in {"auto", "manual"}:
            raise HTTPException(status_code=400, detail="mode must be 'auto' or 'manual'")
        settings["runtime_profile_mode"] = mode
    if "manual_profile" in body:
        profile = str(body.get("manual_profile") or "").strip()
        if profile and profile not in RUNTIME_PROFILES:
            raise HTTPException(status_code=400, detail=f"manual_profile must be one of {sorted(RUNTIME_PROFILES.keys())}")
        settings["runtime_manual_profile"] = profile
    if "manual_until" in body:
        settings["runtime_manual_until"] = body.get("manual_until")
    if "auto_enabled" in body:
        settings["runtime_auto_enabled"] = 1 if bool(body.get("auto_enabled")) else 0
    if "autotune_interval_sec" in body:
        settings["runtime_autotune_interval_sec"] = max(5, min(300, int(body.get("autotune_interval_sec"))))
    if "profile_cooldown_sec" in body:
        settings["runtime_profile_cooldown_sec"] = max(15, min(3600, int(body.get("profile_cooldown_sec"))))
    if "stream_grab_latest" in body:
        settings["runtime_stream_grab_latest"] = 1 if bool(body.get("stream_grab_latest")) else 0

    await (
        sb.table("cameras")
        .update({"count_settings": settings})
        .eq("id", cam_id)
        .execute()
    )
    return {
        "ok": True,
        "camera_id": cam_id,
        "count_settings": settings,
        "note": "Persisted to cameras.count_settings. Runtime applies on next counter refresh.",
    }

# ── Audit logging ──────────────────────────────────────────────────────────────

_audit_logger = logging.getLogger("admin.audit")

def _audit(user: dict, action: str, detail: str) -> None:
    """Emit a structured audit log line for every destructive/privileged admin op."""
    uid = (user or {}).get("sub") or (user or {}).get("id") or "unknown"
    _audit_logger.warning("[AUDIT] user=%s action=%s %s", uid, action, detail)


# ── Data maintenance ───────────────────────────────────────────────────────────

_MIN_PRUNE_DAYS = 7    # never allow pruning data newer than 7 days

@router.post("/prune")
async def prune_old_data(
    request: Request,
    _user: dict = Depends(_require_admin_user),
):
    """
    Delete rows older than `days` from ml_detection_events, count_snapshots, messages.
    Body: {"days": 14, "dry_run": false, "confirm": true}
    - Minimum 7 days (cannot delete recent data)
    - Requires confirm=true for destructive (non-dry-run) runs
    """
    from scripts.prune_old_data import prune
    body = await request.json()
    days    = int(body.get("days", 14))
    dry_run = bool(body.get("dry_run", False))
    confirm = bool(body.get("confirm", False))

    if days < _MIN_PRUNE_DAYS or days > 365:
        raise HTTPException(status_code=400, detail=f"days must be {_MIN_PRUNE_DAYS}–365")
    if not dry_run and not confirm:
        raise HTTPException(
            status_code=400,
            detail='Set "confirm": true to execute a destructive prune. Use "dry_run": true to preview.',
        )

    _audit(_user, "prune_old_data", f"days={days} dry_run={dry_run}")
    result = await prune(days=days, dry_run=dry_run)
    return result


@router.get("/leaderboard")
async def admin_leaderboard(
    window: int = Query(60, description="Window in seconds: 60, 180, or 300"),
    _user: dict = Depends(_require_admin_user),
):
    """Return cached pre-aggregated leaderboard for the given window."""
    from services.leaderboard_service import get_leaderboard
    if window not in (60, 180, 300):
        raise HTTPException(status_code=400, detail="window must be 60, 180, or 300")
    return get_leaderboard(window)


@router.get("/daily-summary")
async def admin_daily_summary(
    date: str = Query(..., description="Date (YYYY-MM-DD)"),
    _user: dict = Depends(_require_admin_user),
):
    """Build and return a daily traffic summary for the given date."""
    from services.daily_summary_service import build_daily_summary
    from datetime import datetime, timezone
    try:
        dt = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD.")
    summary = await build_daily_summary(dt)
    return summary


async def _resolve_runtime_camera_id(sb, cfg, camera_id: str | None) -> str:
    if camera_id:
        return str(camera_id)
    cam_resp = await (
        sb.table("cameras")
        .select("id")
        .eq("ipcam_alias", cfg.CAMERA_ALIAS)
        .limit(1)
        .execute()
    )
    if cam_resp.data:
        return str(cam_resp.data[0]["id"])
    active_resp = await (
        sb.table("cameras")
        .select("id")
        .eq("is_active", True)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    if active_resp.data:
        return str(active_resp.data[0]["id"])
    raise HTTPException(status_code=404, detail="No camera found for runtime profile controls")


# ── Camera Switch ──────────────────────────────────────────────────────────────

class CameraSwitchPayload(BaseModel):
    camera_id: str


@router.post("/camera-switch")
async def admin_camera_switch(
    body: CameraSwitchPayload,
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    """
    Atomically switch the active AI camera.
    1. Updates cameras.is_active in Supabase (exclusive — one active at a time).
    2. Signals url_refresh_loop to run immediately (bypass the 4-min interval).
    3. The AI loop detects the alias change on next frame and resets tracker +
       counter + scene lock automatically.
    Total switch time: < 30s (time to fetch a fresh HLS manifest for new camera).
    """
    camera_id = str(body.camera_id).strip()
    if not camera_id:
        raise HTTPException(status_code=400, detail="camera_id is required")

    sb = await get_supabase()

    # Verify camera exists
    cam_resp = await (
        sb.table("cameras")
        .select("id, ipcam_alias, youtube_url, name")
        .eq("id", camera_id)
        .limit(1)
        .execute()
    )
    if not cam_resp.data:
        raise HTTPException(status_code=404, detail=f"Camera {camera_id!r} not found")

    # Exclusive activation: deactivate all others, activate target
    await (
        sb.table("cameras")
        .update({"is_active": False})
        .neq("id", camera_id)
        .execute()
    )
    await (
        sb.table("cameras")
        .update({"is_active": True})
        .eq("id", camera_id)
        .execute()
    )

    # Wake up url_refresh_loop to pick up the new active camera immediately
    # Non-fatal: DB update already committed above, so swallow any signal error
    try:
        trigger_force_refresh()
    except Exception as _rf_exc:
        logger.warning("trigger_force_refresh error (non-fatal): %s", _rf_exc)

    switched_at = datetime.now(timezone.utc).isoformat()
    cam_data = cam_resp.data[0]
    alias = cam_data.get("ipcam_alias") or ""
    youtube_url = cam_data.get("youtube_url") or ""
    cam_name = cam_data.get("name") or alias or camera_id
    logger.info(
        "Admin camera switch: id=%s alias=%s youtube=%s at=%s",
        camera_id, alias or "(none)", youtube_url or "(none)", switched_at,
    )

    return {
        "ok": True,
        "camera_id": camera_id,
        "alias": alias,
        "youtube_url": youtube_url,
        "name": cam_name,
        "switched_at": switched_at,
    }


@router.post("/force-scene-reset")
async def admin_force_scene_reset(
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    """
    Force the AI detection loop to reset its scene state immediately.
    1. Broadcasts a 'scene:reset' WebSocket event so all clients clear stale boxes.
    2. Triggers url_refresh_loop to run now, which causes the AI loop to detect
       the (possibly changed) alias and re-initialise counter + tracker.
    """
    try:
        await manager.broadcast_public({"type": "scene:reset"})
    except Exception as exc:
        logger.warning("scene:reset broadcast error (non-fatal): %s", exc)

    try:
        trigger_force_refresh()
    except Exception as exc:
        logger.warning("trigger_force_refresh error (non-fatal): %s", exc)

    logger.info("Admin forced scene reset by user=%s", admin.get("sub", "?"))
    return {"ok": True, "message": "Scene reset triggered — detection will re-initialise within a few seconds."}


@router.post("/demo/record")
async def admin_demo_record(
    admin: Annotated[dict, Depends(_require_admin_user)],
    duration: int = Query(default=600, ge=30, le=1800, description="Recording duration in seconds (default 600 = 10 min)"),
):
    """Start a background recording of the live stream and upload to Supabase storage demo-videos bucket."""
    from services import demo_recorder
    cfg = get_config()
    result = await demo_recorder.start_recording(duration_sec=duration, cfg=cfg)
    return result


@router.get("/demo/record/status")
async def admin_demo_record_status(
    admin: Annotated[dict, Depends(_require_admin_user)],
):
    """Check the status of the current or last demo recording."""
    from services import demo_recorder
    return demo_recorder.get_status()


@router.post("/backfill-daily")
async def admin_backfill_daily(
    admin: Annotated[dict, Depends(_require_admin_user)],
    date: str = Query(..., description="UTC date to aggregate, YYYY-MM-DD"),
):
    """
    Manually trigger traffic_daily aggregation for a specific UTC date.
    Use this to backfill historical data after the service starts.
    Example: POST /admin/backfill-daily?date=2026-03-07
    """
    from services.traffic_daily_service import aggregate_day
    try:
        target = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    try:
        result = await aggregate_day(target)
        return {"ok": True, **result}
    except Exception as exc:
        logger.error("[Admin] backfill-daily failed for %s: %s", date, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
