"""
scripts/seed_rounds.py — Pre-generate bet_rounds for a given date.

Useful for:
  - Pre-warming before a high-traffic event
  - Recovering rounds after a database wipe
  - Testing without running the full backend

Usage:
    python -m scripts.seed_rounds --date 2025-09-01 --window 60
    python -m scripts.seed_rounds --date 2025-09-01 --window 60,180,300
    python -m scripts.seed_rounds --date 2025-09-01 --window all --camera-id <uuid>
    python -m scripts.seed_rounds --dry-run

Rounds are spaced to fill the entire calendar day with non-overlapping windows.
Existing rounds for the same camera + window + time range are skipped.

Env vars required:
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, optionally CAMERA_ALIAS
"""
import argparse
import asyncio
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

_DEFAULT_WINDOWS = [60, 180, 300]

_WINDOW_MARKETS = {
    60: [
        {"label": "Over 5 vehicles",    "outcome_key": "over",  "odds": 1.85},
        {"label": "Under 5 vehicles",   "outcome_key": "under", "odds": 1.85},
        {"label": "Exactly 5 vehicles", "outcome_key": "exact", "odds": 15.0},
    ],
    180: [
        {"label": "Over 15 vehicles",    "outcome_key": "over",  "odds": 1.85},
        {"label": "Under 15 vehicles",   "outcome_key": "under", "odds": 1.85},
        {"label": "Exactly 15 vehicles", "outcome_key": "exact", "odds": 15.0},
    ],
    300: [
        {"label": "Over 25 vehicles",    "outcome_key": "over",  "odds": 1.85},
        {"label": "Under 25 vehicles",   "outcome_key": "under", "odds": 1.85},
        {"label": "Exactly 25 vehicles", "outcome_key": "exact", "odds": 15.0},
    ],
}


async def _get_active_camera_id(sb) -> str | None:
    resp = await sb.table("cameras").select("id").eq("is_active", True).limit(1).execute()
    rows = resp.data or []
    return str(rows[0]["id"]) if rows else None


async def seed(
    date: datetime,
    windows: list[int],
    camera_id: str | None,
    dry_run: bool,
) -> dict[str, Any]:
    from supabase_client import get_supabase
    sb = await get_supabase()

    if not camera_id:
        camera_id = await _get_active_camera_id(sb)
    if not camera_id:
        print("No active camera found. Pass --camera-id explicitly.", file=sys.stderr)
        return {"error": "no_camera"}

    day_start = date.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=timezone.utc)
    day_end   = day_start + timedelta(days=1)

    # Load existing rounds for this day to avoid duplicates
    existing_resp = await (
        sb.table("bet_rounds")
        .select("opens_at, ends_at, window_duration_sec")
        .eq("camera_id", camera_id)
        .gte("opens_at", day_start.isoformat())
        .lt("opens_at", day_end.isoformat())
        .execute()
    )
    existing = existing_resp.data or []
    existing_opens = {
        (r["window_duration_sec"], r["opens_at"]) for r in existing
    }

    created = 0
    skipped = 0
    results: list[dict] = []

    for window_sec in windows:
        current = day_start
        betting_window_sec = max(10, window_sec - 10)   # 10s close before round ends

        while current < day_end:
            opens_at  = current
            closes_at = current + timedelta(seconds=betting_window_sec)
            ends_at   = current + timedelta(seconds=window_sec)

            key = (window_sec, opens_at.isoformat())
            if key in existing_opens:
                skipped += 1
                current += timedelta(seconds=window_sec)
                continue

            round_row: dict[str, Any] = {
                "camera_id":          camera_id,
                "status":             "pending",
                "market_type":        "over_under",
                "opens_at":           opens_at.isoformat(),
                "closes_at":          closes_at.isoformat(),
                "ends_at":            ends_at.isoformat(),
                "window_duration_sec": window_sec,
                "params":             {"threshold": 5 if window_sec == 60 else (15 if window_sec == 180 else 25)},
            }

            if dry_run:
                print(f"[DRY-RUN] window={window_sec}s opens={opens_at.isoformat()}")
                results.append(round_row)
            else:
                try:
                    resp = await sb.table("bet_rounds").insert(round_row).execute()
                    round_id = (resp.data or [{}])[0].get("id")

                    # Insert markets
                    if round_id:
                        markets = [
                            {**m, "round_id": round_id}
                            for m in _WINDOW_MARKETS.get(window_sec, [])
                        ]
                        if markets:
                            await sb.table("markets").insert(markets).execute()
                    created += 1
                    results.append({"round_id": round_id, **round_row})
                    print(f"[CREATED] window={window_sec}s opens={opens_at.isoformat()}")
                except Exception as exc:
                    print(f"[ERROR]   window={window_sec}s opens={opens_at.isoformat()}: {exc}", file=sys.stderr)

            current += timedelta(seconds=window_sec)

    return {
        "date":       date.date().isoformat(),
        "camera_id":  camera_id,
        "windows":    windows,
        "created":    created,
        "skipped":    skipped,
        "dry_run":    dry_run,
        "rounds":     results if dry_run else [],
    }


async def _main() -> None:
    parser = argparse.ArgumentParser(description="Seed bet_rounds for a given date.")
    parser.add_argument("--date",       type=str,  default=None, help="Date to seed (YYYY-MM-DD, default: today UTC)")
    parser.add_argument("--window",     type=str,  default="all", help="Window(s): 60, 180, 300, or all (default: all)")
    parser.add_argument("--camera-id",  type=str,  default=None, help="Camera UUID (default: active camera)")
    parser.add_argument("--dry-run",    action="store_true",     help="Print rounds without inserting")
    args = parser.parse_args()

    if args.date:
        try:
            date = datetime.strptime(args.date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            print("Invalid date format. Use YYYY-MM-DD.", file=sys.stderr)
            sys.exit(1)
    else:
        date = datetime.now(timezone.utc)

    if args.window == "all":
        windows = _DEFAULT_WINDOWS
    else:
        try:
            windows = [int(w.strip()) for w in args.window.split(",")]
        except ValueError:
            print("Invalid --window. Use e.g. 60 or 60,180,300 or all.", file=sys.stderr)
            sys.exit(1)

    result = await seed(date, windows, args.camera_id, args.dry_run)
    print("\nResult:", result)


if __name__ == "__main__":
    asyncio.run(_main())
