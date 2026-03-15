"""
scripts/prune_old_data.py — Delete old rows from high-volume tables.

Usage:
    python -m scripts.prune_old_data --days 7
    python -m scripts.prune_old_data --days 14 --dry-run

Tables pruned:
    ml_detection_events   — grows at ~15 rows/sec during active detection
    count_snapshots       — grows at ~1 row/sec
    messages              — chat messages older than N days

Also exposed as an admin API endpoint via routers/admin.py:
    POST /api/admin/prune   body: {"days": 7}

Env vars required (same as main app):
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
"""
import argparse
import asyncio
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

_TABLES = [
    "ml_detection_events",
    "count_snapshots",
    "messages",
]


async def prune(days: int, dry_run: bool = False) -> dict[str, Any]:
    """
    Delete rows older than `days` from each prunable table.
    Returns a summary dict with deleted counts per table.
    """
    from supabase_client import get_supabase

    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    results: dict[str, Any] = {
        "cutoff": cutoff,
        "days": days,
        "dry_run": dry_run,
        "tables": {},
    }

    sb = await get_supabase()

    for table in _TABLES:
        ts_col = "captured_at" if table != "messages" else "created_at"
        try:
            if dry_run:
                # Count only
                resp = await (
                    sb.table(table)
                    .select("id", count="exact")
                    .lt(ts_col, cutoff)
                    .execute()
                )
                count = getattr(resp, "count", None) or len(resp.data or [])
                results["tables"][table] = {"would_delete": count, "dry_run": True}
                print(f"[DRY-RUN] {table}: {count} rows would be deleted (older than {days}d)")
            else:
                resp = await (
                    sb.table(table)
                    .delete()
                    .lt(ts_col, cutoff)
                    .execute()
                )
                deleted = len(resp.data or [])
                results["tables"][table] = {"deleted": deleted}
                print(f"[PRUNED]  {table}: {deleted} rows deleted (older than {days}d)")
        except Exception as exc:
            results["tables"][table] = {"error": str(exc)}
            print(f"[ERROR]   {table}: {exc}", file=sys.stderr)

    results["pruned_at"] = datetime.now(timezone.utc).isoformat()
    return results


async def _main() -> None:
    parser = argparse.ArgumentParser(description="Prune old Whitelinez data from Supabase.")
    parser.add_argument("--days", type=int, default=14, help="Delete rows older than N days (default: 14)")
    parser.add_argument("--dry-run", action="store_true", help="Count rows without deleting")
    args = parser.parse_args()

    if args.days < 1:
        print("--days must be >= 1", file=sys.stderr)
        sys.exit(1)

    result = await prune(args.days, dry_run=args.dry_run)
    print("\nSummary:", result)


if __name__ == "__main__":
    asyncio.run(_main())
