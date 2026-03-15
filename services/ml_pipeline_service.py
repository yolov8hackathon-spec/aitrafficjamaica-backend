"""
services/ml_pipeline_service.py - ML pipeline orchestration.

Real training is expected to run on an external GPU worker and report metrics
back through a webhook response. Railway only orchestrates and gates promotion.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from fastapi import HTTPException

from config import get_config
from supabase_client import get_supabase


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _score(metrics: dict[str, Any] | None) -> float:
    if not metrics:
        return 0.0
    m50 = float(metrics.get("mAP50", 0.0) or 0.0)
    precision = float(metrics.get("precision", 0.0) or 0.0)
    recall = float(metrics.get("recall", 0.0) or 0.0)
    return (0.50 * m50) + (0.25 * precision) + (0.25 * recall)


async def export_dataset_job(hours: int = 24) -> dict[str, Any]:
    sb = await get_supabase()
    since = datetime.now(timezone.utc) - timedelta(hours=max(1, min(hours, 24 * 30)))
    since_iso = since.isoformat()

    telemetry = await (
        sb.table("ml_detection_events")
        .select("camera_id, captured_at, class_counts, avg_confidence, detections_count, new_crossings")
        .gte("captured_at", since_iso)
        .order("captured_at", desc=False)
        .limit(50000)
        .execute()
    )
    rows = telemetry.data or []
    if not rows:
        raise HTTPException(status_code=400, detail="No telemetry rows available for dataset export")

    avg_conf = sum(float(r.get("avg_confidence") or 0) for r in rows) / len(rows)
    crossings = sum(int(r.get("new_crossings") or 0) for r in rows)
    manifest = {
        "window_hours": hours,
        "rows": len(rows),
        "avg_confidence": round(avg_conf, 5),
        "new_crossings_total": crossings,
        "exported_at": _utc_now_iso(),
        "features": ["class_counts", "avg_confidence", "detections_count", "new_crossings"],
    }
    job = {
        "job_type": "export",
        "status": "completed",
        "provider": "internal",
        "started_at": _utc_now_iso(),
        "completed_at": _utc_now_iso(),
        "params": {"hours": hours},
        "metrics": {"telemetry_rows": len(rows), "avg_confidence": round(avg_conf, 5), "new_crossings_total": crossings},
        "artifact_manifest": manifest,
        "notes": "Telemetry export manifest generated",
    }
    resp = await sb.table("ml_training_jobs").insert(job).execute()
    return resp.data[0] if resp.data else job


async def _run_external_training(
    *,
    base_model: str,
    dataset_job_id: int | None,
    params: dict[str, Any],
    provider: str,
    artifact_manifest: dict[str, Any] | None,
) -> dict[str, Any]:
    cfg = get_config()
    webhook = params.get("trainer_webhook_url") or getattr(cfg, "TRAINER_WEBHOOK_URL", "")
    secret = params.get("trainer_webhook_secret") or getattr(cfg, "TRAINER_WEBHOOK_SECRET", "")
    dataset_yaml_url = str(params.get("dataset_yaml_url", "")).strip()
    if not webhook:
        raise HTTPException(status_code=400, detail="TRAINER_WEBHOOK_URL is required for external training")
    if not dataset_yaml_url:
        raise HTTPException(status_code=400, detail="dataset_yaml_url is required for external training")

    payload = {
        "base_model": base_model,
        "dataset_job_id": dataset_job_id,
        "dataset_manifest": artifact_manifest,
        "provider": provider,
        "params": params,
        "requested_at": _utc_now_iso(),
    }
    headers = {"Content-Type": "application/json"}
    if secret:
        headers["Authorization"] = f"Bearer {secret}"

    timeout_sec = int(params.get("trainer_timeout_sec", 900))
    async with httpx.AsyncClient(timeout=timeout_sec, follow_redirects=False) as client:
        resp = await client.post(webhook, json=payload, headers=headers)
    if resp.status_code < 200 or resp.status_code >= 300:
        body = (resp.text or "").strip()
        if len(body) > 400:
            body = body[:400] + "...(truncated)"
        detail = f"Trainer webhook failed: {resp.status_code}"
        location = resp.headers.get("location")
        if location:
            detail += f" location={location}"
        if body:
            detail += f" body={body}"
        raise HTTPException(status_code=502, detail=detail)

    raw_body = (resp.text or "").strip()
    try:
        data = resp.json()
    except Exception:
        body_preview = raw_body
        if len(body_preview) > 400:
            body_preview = body_preview[:400] + "...(truncated)"
        content_type = resp.headers.get("content-type", "unknown")
        detail = (
            "Trainer webhook returned non-JSON success response: "
            f"status={resp.status_code} content_type={content_type}"
        )
        if body_preview:
            detail += f" body={body_preview}"
        raise HTTPException(status_code=502, detail=detail)

    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="Trainer webhook JSON response must be an object")
    if not data.get("model_uri"):
        raise HTTPException(status_code=502, detail="Trainer webhook missing model_uri")
    metrics = data.get("metrics") or {}
    return {
        "model_name": data.get("model_name") or f"whitelinez-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}",
        "model_uri": data["model_uri"],
        "metrics": metrics,
        "notes": data.get("notes", "Training completed via webhook"),
    }


async def start_training_job(
    *,
    base_model: str,
    dataset_job_id: int | None,
    provider: str = "webhook",
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    sb = await get_supabase()
    params = params or {}
    artifact_manifest = None
    if dataset_job_id is not None:
        ds = await (
            sb.table("ml_training_jobs")
            .select("id, artifact_manifest, status, job_type")
            .eq("id", dataset_job_id)
            .single()
            .execute()
        )
        if not ds.data or ds.data.get("job_type") != "export":
            raise HTTPException(status_code=404, detail="Dataset export job not found")
        if ds.data.get("status") != "completed":
            raise HTTPException(status_code=400, detail="Dataset export job is not completed")
        artifact_manifest = ds.data.get("artifact_manifest")

    train_job = {
        "job_type": "train",
        "status": "running",
        "provider": provider,
        "started_at": _utc_now_iso(),
        "params": {"base_model": base_model, "dataset_job_id": dataset_job_id, **params},
        "metrics": {},
        "artifact_manifest": artifact_manifest,
        "notes": "Training started",
    }
    job_resp = await sb.table("ml_training_jobs").insert(train_job).execute()
    job_row = (job_resp.data or [train_job])[0]
    job_id = job_row.get("id")

    try:
        trained = await _run_external_training(
            base_model=base_model,
            dataset_job_id=dataset_job_id,
            params=params,
            provider=provider,
            artifact_manifest=artifact_manifest,
        )
        done_metrics = trained.get("metrics") or {}
        await (
            sb.table("ml_training_jobs")
            .update(
                {
                    "status": "completed",
                    "completed_at": _utc_now_iso(),
                    "metrics": done_metrics,
                    "notes": trained.get("notes", "Training completed"),
                }
            )
            .eq("id", job_id)
            .execute()
        )

        candidate = {
            "model_name": trained["model_name"],
            "model_uri": trained["model_uri"],
            "base_model": base_model,
            "training_job_id": job_id,
            "status": "candidate",
            "metrics": done_metrics,
            "created_at": _utc_now_iso(),
            "promoted_at": None,
        }
        model_resp = await sb.table("ml_model_registry").insert(candidate).execute()
        model_row = (model_resp.data or [candidate])[0]
        return {"job_id": job_id, "status": "completed", "model": model_row}
    except Exception as exc:
        await (
            sb.table("ml_training_jobs")
            .update({"status": "failed", "completed_at": _utc_now_iso(), "notes": f"{exc}"})
            .eq("id", job_id)
            .execute()
        )
        raise


async def promote_model(model_id: int) -> dict[str, Any]:
    sb = await get_supabase()
    model_resp = await sb.table("ml_model_registry").select("*").eq("id", model_id).single().execute()
    model = model_resp.data
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    await sb.table("ml_model_registry").update({"status": "archived"}).eq("status", "active").execute()
    now_iso = _utc_now_iso()
    upd = await (
        sb.table("ml_model_registry")
        .update({"status": "active", "promoted_at": now_iso})
        .eq("id", model_id)
        .execute()
    )
    return (upd.data or [model])[0]


async def get_active_model() -> dict[str, Any] | None:
    sb = await get_supabase()
    resp = await (
        sb.table("ml_model_registry")
        .select("*")
        .eq("status", "active")
        .order("promoted_at", desc=True)
        .limit(1)
        .execute()
    )
    if resp.data:
        return resp.data[0]
    return None


async def auto_retrain_cycle(
    *,
    hours: int = 24,
    min_rows: int = 1000,
    min_score_gain: float = 0.015,
    base_model: str = "yolov8s.pt",
    provider: str = "webhook",
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    params = params or {}
    ds = await export_dataset_job(hours=hours)
    rows = int((ds.get("metrics") or {}).get("telemetry_rows", 0))
    if rows < min_rows:
        return {
            "status": "skipped",
            "reason": f"Not enough telemetry rows ({rows} < {min_rows})",
            "dataset_job": ds,
        }

    train = await start_training_job(
        base_model=base_model,
        dataset_job_id=ds.get("id"),
        provider=provider,
        params=params,
    )
    model = train.get("model") or {}
    cand_metrics = model.get("metrics") or {}
    cand_score = _score(cand_metrics)

    active = await get_active_model()
    active_score = _score((active or {}).get("metrics") or {})
    improved = (cand_score - active_score) >= min_score_gain

    promoted = None
    if improved:
        promoted = await promote_model(int(model["id"]))

    return {
        "status": "completed",
        "dataset_job_id": ds.get("id"),
        "training_job_id": train.get("job_id"),
        "candidate_model_id": model.get("id"),
        "candidate_score": round(cand_score, 6),
        "active_score": round(active_score, 6),
        "min_score_gain": min_score_gain,
        "promoted": bool(promoted),
        "promoted_model": promoted,
    }


async def list_jobs(limit: int = 100) -> list[dict[str, Any]]:
    sb = await get_supabase()
    resp = await sb.table("ml_training_jobs").select("*").order("id", desc=True).limit(max(1, min(limit, 500))).execute()
    return resp.data or []


async def list_models(limit: int = 100) -> list[dict[str, Any]]:
    sb = await get_supabase()
    resp = await sb.table("ml_model_registry").select("*").order("id", desc=True).limit(max(1, min(limit, 500))).execute()
    return resp.data or []


async def get_active_model_uri() -> str | None:
    active = await get_active_model()
    if active:
        return active.get("model_uri")
    return None


async def get_ml_diagnostics(*, cfg=None) -> dict[str, Any]:
    cfg = cfg or get_config()
    sb = await get_supabase()

    since_24h = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()

    schema_error: str | None = None
    total_rows = 0
    rows_24h = 0
    latest_det = None
    latest_job = None
    active_model = None

    try:
        total_rows_resp = await (
            sb.table("ml_detection_events")
            .select("id", count="exact")
            .limit(1)
            .execute()
        )
        rows_24h_resp = await (
            sb.table("ml_detection_events")
            .select("id", count="exact")
            .gte("captured_at", since_24h)
            .limit(1)
            .execute()
        )
        latest_det_resp = await (
            sb.table("ml_detection_events")
            .select("captured_at, avg_confidence, model_name")
            .order("captured_at", desc=True)
            .limit(1)
            .execute()
        )
        latest_job_resp = await (
            sb.table("ml_training_jobs")
            .select("id, job_type, status, created_at, completed_at, notes")
            .eq("job_type", "train")
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        active_model = await get_active_model()

        total_rows = int(total_rows_resp.count if total_rows_resp.count is not None else len(total_rows_resp.data or []))
        rows_24h = int(rows_24h_resp.count if rows_24h_resp.count is not None else len(rows_24h_resp.data or []))
        latest_det = (latest_det_resp.data or [None])[0]
        latest_job = (latest_job_resp.data or [None])[0]
    except Exception as exc:
        schema_error = str(exc)

    checks: list[dict[str, Any]] = []

    def push(name: str, ok: bool, detail: str, *, required: bool = True, value: Any = None) -> None:
        checks.append(
            {
                "name": name,
                "status": "ok" if ok else "fail",
                "required": required,
                "detail": detail,
                "value": value,
            }
        )

    webhook_ok = bool(str(getattr(cfg, "TRAINER_WEBHOOK_URL", "") or "").strip())
    webhook_secret_ok = bool(str(getattr(cfg, "TRAINER_WEBHOOK_SECRET", "") or "").strip())
    dataset_yaml_ok = bool(str(getattr(cfg, "TRAINER_DATASET_YAML_URL", "") or "").strip())
    auto_loop_on = int(getattr(cfg, "ML_AUTO_RETRAIN_ENABLED", 0) or 0) == 1

    push("Trainer webhook", webhook_ok, "TRAINER_WEBHOOK_URL is set" if webhook_ok else "Missing TRAINER_WEBHOOK_URL", value=getattr(cfg, "TRAINER_WEBHOOK_URL", ""))
    push("Trainer secret", webhook_secret_ok, "TRAINER_WEBHOOK_SECRET is set" if webhook_secret_ok else "Missing TRAINER_WEBHOOK_SECRET")
    push("Dataset YAML URL", dataset_yaml_ok, "TRAINER_DATASET_YAML_URL is set" if dataset_yaml_ok else "Missing TRAINER_DATASET_YAML_URL", value=getattr(cfg, "TRAINER_DATASET_YAML_URL", ""))
    if schema_error:
        push(
            "ML schema",
            False,
            f"ML tables unavailable or not migrated: {schema_error}",
            value="missing_or_incompatible_tables",
        )
    push(
        "Auto retrain loop",
        auto_loop_on,
        "ML_AUTO_RETRAIN_ENABLED=1" if auto_loop_on else "ML_AUTO_RETRAIN_ENABLED is disabled",
        required=False,
        value=int(getattr(cfg, "ML_AUTO_RETRAIN_ENABLED", 0) or 0),
    )
    push(
        "Telemetry volume",
        total_rows > 0,
        f"{total_rows:,} total rows collected" if total_rows > 0 else "No ml_detection_events rows yet",
        value=total_rows,
    )
    push(
        "24h throughput",
        rows_24h >= int(getattr(cfg, "ML_AUTO_RETRAIN_MIN_ROWS", 1000) or 1000),
        f"{rows_24h:,} rows in last 24h",
        required=False,
        value=rows_24h,
    )
    push(
        "Active model",
        bool(active_model),
        f"Active model: {active_model.get('model_name')}" if active_model else "No active model promoted yet",
        required=False,
        value=(active_model or {}).get("model_name"),
    )

    latest_error = None
    if latest_job and latest_job.get("status") == "failed":
        latest_error = str(latest_job.get("notes") or "Training failed")

    blocking = [c for c in checks if c["required"] and c["status"] != "ok"]
    ready_for_one_click = len(blocking) == 0

    return {
        "ready_for_one_click": ready_for_one_click,
        "checks": checks,
        "latest_train_job": latest_job,
        "latest_error": latest_error,
        "latest_detection": latest_det,
        "targets": {
            "min_rows_24h": int(getattr(cfg, "ML_AUTO_RETRAIN_MIN_ROWS", 1000) or 1000),
            "min_score_gain": float(getattr(cfg, "ML_AUTO_RETRAIN_MIN_SCORE_GAIN", 0.015) or 0.015),
            "interval_min": int(getattr(cfg, "ML_AUTO_RETRAIN_INTERVAL_MIN", 180) or 180),
        },
        "summary": {
            "total_rows": total_rows,
            "rows_24h": rows_24h,
            "active_model_name": (active_model or {}).get("model_name"),
            "latest_model_name": (latest_det or {}).get("model_name"),
        },
    }
