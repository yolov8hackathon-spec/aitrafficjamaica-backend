"""
ai/counter.py — Vehicle counter. Supports LineZone (2-point) and PolygonZone (4-point).
Polls cameras table every 30 s for zone config. Exclusion zones suppress detections.
No detect-zone prevalidation, no EMA hysteresis, no burst mode.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any

import cv2
import numpy as np
import supervision as sv

from ai.detector import CLASS_NAMES
from config import get_config
from supabase_client import get_supabase

logger = logging.getLogger(__name__)

LINE_REFRESH_INTERVAL  = 30   # seconds
TRACK_TTL_SEC          = 10.0
DEDUP_RADIUS_RATIO     = 0.06  # 6% of frame diagonal — suppresses same-vehicle re-counts
DEDUP_TTL_SEC          = 2.0   # seconds to remember a counted position

# ── Vehicle color detection ───────────────────────────────────────────────────

def _sample_vehicle_color(frame: np.ndarray, x1: int, y1: int, x2: int, y2: int) -> str:
    """
    Estimate the dominant body color of a vehicle from its bounding box.
    Crops the inner 60% of the box (avoids road/sky bleed at edges), converts
    BGR→HSV, takes the median H/S/V, and maps to a color name.
    Returns 'unknown' if the box is too small or the frame is unavailable.
    """
    if frame is None:
        return "unknown"
    fh, fw = frame.shape[:2]
    # Shrink to inner 60%: 20% padding on each side
    pw = max(2, int((x2 - x1) * 0.20))
    ph = max(2, int((y2 - y1) * 0.20))
    cx1, cy1 = max(0, x1 + pw), max(0, y1 + ph)
    cx2, cy2 = min(fw, x2 - pw), min(fh, y2 - ph)
    if cx2 - cx1 < 4 or cy2 - cy1 < 4:
        return "unknown"
    crop = frame[cy1:cy2, cx1:cx2]
    if crop.size == 0:
        return "unknown"
    # Optionally downsample for speed on large boxes
    if crop.shape[0] > 32 or crop.shape[1] > 32:
        crop = cv2.resize(crop, (32, 32), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    h_med = float(np.median(hsv[:, :, 0]))   # OpenCV H: 0–180
    s_med = float(np.median(hsv[:, :, 1]))   # S: 0–255
    v_med = float(np.median(hsv[:, :, 2]))   # V: 0–255
    # Achromatic (low saturation)
    if s_med < 45:
        if v_med < 55:  return "black"
        if v_med > 185: return "white"
        return "silver"
    # Chromatic — map OpenCV H (0–180) to color names
    h = h_med * 2  # → 0–360
    if h < 15 or h >= 340: return "red"
    if h < 35:  return "orange"
    if h < 65:  return "yellow"
    if h < 85:  return "lime"
    if h < 165: return "green"
    if h < 195: return "cyan"
    if h < 255: return "blue"
    if h < 285: return "purple"
    if h < 340: return "pink"
    return "red"

# ── defaults (all overridable via cameras.count_settings) ─────────────────────
DEFAULTS: dict[str, Any] = {
    "min_confidence":       0.22,
    "min_box_area_ratio":   0.001,
    "min_track_frames":     2,
    "allowed_classes":      ["car", "truck", "bus", "motorcycle"],
    "class_min_confidence": {"car": 0.22, "truck": 0.25, "bus": 0.25, "motorcycle": 0.22},
    "count_unknown_as_car": True,
}


class LineCounter:
    """
    Counts vehicles crossing a LineZone or dwelling in a PolygonZone.

    Public API used by main.py:
        process(frame, detections) → snapshot dict
        set_scene_status(scene)
        get_setting(key, default)
        bootstrap_from_latest_snapshot()
        reset_round()
        _confirmed_total  (int, read by main.py on startup)
    """

    def __init__(self, camera_id: str, frame_width: int, frame_height: int) -> None:
        self.camera_id    = camera_id
        self.frame_width  = frame_width
        self.frame_height = frame_height

        self._zone:        sv.LineZone | sv.PolygonZone | None = None
        self._zone_type:   str = "line"   # "line" | "polygon" | "line_pixel"
        self._zone_name:   str = "Main Zone"   # readable name for vehicle_crossings
        self._zone_coords: tuple[int, int, int, int] = (0, 0, 0, 0)  # (x1,y1,x2,y2) pixels
        self._line_seg:    tuple[int, int, int, int] | None = None   # raw pixel endpoints for bbox check
        self._excl_polys:  list[np.ndarray] = []  # pixel-coord polygons for CENTER exclusion
        self._detect_poly: np.ndarray | None = None  # inclusion zone — None = whole frame
        self._detect_zone_sv: sv.PolygonZone | None = None  # secondary fallback counter
        self._detect_inside_ids: set[int] = set()  # tracks inside detect zone last frame
        self._last_refresh = 0.0

        # counts
        self._confirmed_in:    int = 0
        self._confirmed_out:   int = 0
        self._confirmed_total: int = 0
        self._counts: dict[str, dict[str, int]] = {}   # cls → {in, out}

        # round baseline
        self._round_in:    int = 0
        self._round_out:   int = 0
        self._round_total: int = 0
        self._round_cls:   dict[str, int] = {}

        # track state
        self._confirmed_ids:    set[int] = set()   # already counted
        self._track_frames:     dict[int, int] = {}  # tid → frames seen
        self._track_last_seen:  dict[int, float] = {}
        # pending crossings: vehicles that crossed the line but hadn't reached
        # min_track_frames yet. Keyed by tid, value = direction_in bool.
        # Counted as soon as the track accumulates enough frames.
        self._pending_crossings: dict[int, bool] = {}

        # polygon zone: inside-last-frame memory
        self._inside_ids: set[int] = set()

        # position-based dedup: list of (cx, cy, mono_ts) for recently counted vehicles
        self._recent_count_pos: list[tuple[float, float, float]] = []

        # diagnostic counter for throttled logging
        self._process_calls: int = 0

        # settings + scene
        self._settings:     dict[str, Any] = dict(DEFAULTS)
        self._scene_status: dict[str, Any] = {}

    # ── zone loading ──────────────────────────────────────────────────────────

    async def _refresh(self) -> None:
        sb = await get_supabase()
        resp = (
            await sb.table("cameras")
            .select("count_line, detect_zone, count_settings, scene_map")
            .eq("id", self.camera_id)
            .maybe_single()
            .execute()
        )
        if resp.data is None:
            logger.warning("Counter: camera %s not found", self.camera_id)
            return

        data     = resp.data
        w, h     = self.frame_width, self.frame_height
        cfg_raw  = data.get("count_settings") or {}
        if not isinstance(cfg_raw, dict):
            cfg_raw = {}

        # merge settings
        merged = dict(DEFAULTS)
        merged.update({k: v for k, v in cfg_raw.items() if v is not None})
        self._zone_name = str(cfg_raw.get("zone_name") or "Main Zone").strip() or "Main Zone"
        merged["min_track_frames"]   = max(1, min(4, int(merged.get("min_track_frames", 2) or 2)))
        merged["min_confidence"]     = max(0.10, min(0.60, float(merged.get("min_confidence", 0.22) or 0.22)))
        merged["min_box_area_ratio"] = max(0.0, min(0.05, float(merged.get("min_box_area_ratio", 0.001) or 0.001)))
        cls_conf_raw = merged.get("class_min_confidence", {})
        if not isinstance(cls_conf_raw, dict):
            cls_conf_raw = {}
        merged["class_min_confidence"] = {
            k: max(0.10, min(0.60, float(v)))
            for k, v in cls_conf_raw.items()
        }
        allowed = merged.get("allowed_classes", [])
        merged["allowed_classes"] = [str(x).strip().lower() for x in allowed] if isinstance(allowed, list) else []
        self._settings = merged

        # ── count zone ────────────────────────────────────────────────────────
        # Both 2-point lines and 4-point polygon count lines are converted to a
        # thin PolygonZone "trip-wire" band.  sv.LineZone requires the same tracker
        # ID to transition sides in consecutive frames — impossible when YOLO only
        # detects each vehicle in 1-2 frames at intersection FPS.  The PolygonZone
        # entry-counter counts each new tracker ID the first time its center falls
        # inside the band, which works reliably with tf=1 sporadic detections.
        line = data.get("count_line")

        def _line_to_tripwire(lx1: int, ly1: int, lx2: int, ly2: int) -> np.ndarray:
            """Return a thin rectangular band around the drawn line segment.

            The band is exactly the drawn segment width — no extension to frame edges.
            The admin should draw the line to cover all lanes they want counted.
            half-width: 3% of shorter frame dimension, clamped 18–45 px.
            """
            dx = float(lx2 - lx1)
            dy = float(ly2 - ly1)
            length = max(1.0, (dx * dx + dy * dy) ** 0.5)
            nx, ny = -dy / length, dx / length   # unit perpendicular
            half_w = max(24, min(70, int(min(w, h) * 0.045)))
            return np.array([
                [int(lx1 + nx * half_w), int(ly1 + ny * half_w)],
                [int(lx2 + nx * half_w), int(ly2 + ny * half_w)],
                [int(lx2 - nx * half_w), int(ly2 - ny * half_w)],
                [int(lx1 - nx * half_w), int(ly1 - ny * half_w)],
            ], dtype=np.int32)

        if line and "x3" in line:
            # 4-point polygon drawn by admin — use the midline as the trip-wire axis.
            x1, y1 = int(line["x1"] * w), int(line["y1"] * h)
            x2, y2 = int(line["x2"] * w), int(line["y2"] * h)
            x3, y3 = int(line["x3"] * w), int(line["y3"] * h)
            x4, y4 = int(line["x4"] * w), int(line["y4"] * h)
            mx1, my1 = (x1 + x4) // 2, (y1 + y4) // 2
            mx2, my2 = (x2 + x3) // 2, (y2 + y3) // 2
            self._zone_coords = (mx1, my1, mx2, my2)
            self._zone        = sv.PolygonZone(polygon=_line_to_tripwire(mx1, my1, mx2, my2), triggering_anchors=[sv.Position.CENTER])
            self._zone_type   = "polygon"
            logger.info(
                "Counter zone: polygon→midline trip-wire band (%d,%d)→(%d,%d) camera=%s",
                mx1, my1, mx2, my2, self.camera_id,
            )
        elif line and "x1" in line and "x2" in line:
            # 2-point line drawn by admin — pixel-level bbox intersection trigger.
            # Any detection whose bounding box touches the line segment is counted.
            # No trip-wire band needed — more permissive than center-in-band.
            lx1 = int(float(line["x1"]) * w); ly1 = int(float(line["y1"]) * h)
            lx2 = int(float(line["x2"]) * w); ly2 = int(float(line["y2"]) * h)
            self._zone_coords = (lx1, ly1, lx2, ly2)
            self._line_seg    = (lx1, ly1, lx2, ly2)
            self._zone        = None   # no PolygonZone — raw line segment used directly
            self._zone_type   = "line_pixel"
            logger.info(
                "Counter zone: 2-pt pixel-line (%d,%d)→(%d,%d) camera=%s",
                lx1, ly1, lx2, ly2, self.camera_id,
            )
        else:
            # No count_line configured: use a PolygonZone entry-counter.
            # This is more robust than line-crossing when the detector sporadically
            # misses vehicles (common at intersection cameras where vehicles are
            # briefly occluded or move fast relative to the stream FPS).
            # A vehicle is counted once the FIRST TIME its tracker ID appears
            # inside the zone.  Using detect_zone polygon if available, otherwise
            # a default road-band covering y=0.30-0.70 (full frame width).
            if self._detect_poly is not None:
                zone_poly = self._detect_poly
            else:
                zone_poly = np.array([
                    [0,       int(0.30 * h)],
                    [w,       int(0.30 * h)],
                    [w,       int(0.70 * h)],
                    [0,       int(0.70 * h)],
                ], dtype=np.int32)
            self._zone      = sv.PolygonZone(polygon=zone_poly, triggering_anchors=[sv.Position.CENTER])
            self._zone_type = "polygon"
            logger.info(
                "Counter zone: no count_line → PolygonZone entry-counter camera=%s",
                self.camera_id,
            )

        # ── exclusion zones from scene_map ────────────────────────────────────
        # Use CENTER-point-in-polygon check (cv2.pointPolygonTest) instead of
        # supervision's PolygonZone which uses BOTTOM_CENTER anchor.  This prevents
        # large sidewalk/exclusion zones from excluding vehicles that are near-but-not-
        # inside the zone, and correctly ignores zones that overlap the count band.
        # "crossing" is intentionally excluded: pedestrian crossings should not suppress
        # vehicle detections (vehicles are counted as they cross the intersection).
        excl_polys: list[np.ndarray] = []
        scene_map = data.get("scene_map") or {}
        features  = scene_map.get("features") if isinstance(scene_map, dict) else []
        EXCL_TYPES = {"exclusion", "parking", "sidewalk"}
        if isinstance(features, list):
            for feat in features:
                if not isinstance(feat, dict):
                    continue
                if feat.get("type") not in EXCL_TYPES:
                    continue
                pts = feat.get("points") or []
                pixel_pts = [
                    (int(float(p["x"]) * w), int(float(p["y"]) * h))
                    for p in pts
                    if isinstance(p, dict) and "x" in p and "y" in p
                ]
                if len(pixel_pts) >= 3:
                    excl_polys.append(np.array(pixel_pts, dtype=np.int32))
        self._excl_polys = excl_polys

        # ── detect zone (inclusion filter) ────────────────────────────────────
        # If detect_zone is configured, only detections whose CENTER falls inside
        # this polygon are counted.  This is the primary way to restrict counting
        # to the road area and exclude sky/buildings/parked-car false-positives.
        self._detect_poly = None
        dz = data.get("detect_zone")
        if isinstance(dz, dict):
            dz_pts_raw = dz.get("points") or []
            if not dz_pts_raw:
                # legacy 4-key format {x1,y1,x2,y2,x3,y3,x4,y4}
                if "x1" in dz and "y1" in dz:
                    dz_pts_raw = [
                        {"x": dz["x1"], "y": dz["y1"]},
                        {"x": dz["x2"], "y": dz["y2"]},
                        {"x": dz["x3"], "y": dz["y3"]},
                        {"x": dz["x4"], "y": dz["y4"]},
                    ]
            dz_pixels = [
                (int(float(p["x"]) * w), int(float(p["y"]) * h))
                for p in dz_pts_raw
                if isinstance(p, dict) and "x" in p and "y" in p
            ]
            if len(dz_pixels) >= 3:
                self._detect_poly = np.array(dz_pixels, dtype=np.int32)

        # Secondary zone: PolygonZone over detect_poly for pre-count fallback.
        # Counts any new tracker entering the detect zone that wasn't already
        # counted by the trip-wire.  _confirmed_ids guarantees no double-count.
        if self._detect_poly is not None:
            self._detect_zone_sv = sv.PolygonZone(
                polygon=self._detect_poly,
                triggering_anchors=[sv.Position.CENTER],
            )
        else:
            self._detect_zone_sv = None
        self._detect_inside_ids = set()  # reset on every zone refresh

        self._last_refresh = time.monotonic()
        logger.info(
            "Counter refreshed: zone=%s excl=%d detect_zone=%s camera=%s",
            self._zone_type, len(excl_polys),
            "yes" if self._detect_poly is not None else "none",
            self.camera_id,
        )

    # ── track bookkeeping ─────────────────────────────────────────────────────

    def _touch(self, tid: int) -> None:
        now = time.monotonic()
        self._track_frames[tid]    = self._track_frames.get(tid, 0) + 1
        self._track_last_seen[tid] = now

    def _cleanup(self) -> None:
        now    = time.monotonic()
        stale  = [t for t, ts in self._track_last_seen.items() if now - ts > TRACK_TTL_SEC]
        for t in stale:
            self._track_frames.pop(t, None)
            self._track_last_seen.pop(t, None)
            self._inside_ids.discard(t)
            self._pending_crossings.pop(t, None)  # discard pending if track died
            # do NOT remove from _confirmed_ids — prevents double-count on re-entry

    def _add_count(self, cls_name: str, direction_in: bool) -> None:
        if direction_in:
            self._confirmed_in    += 1
            self._confirmed_total += 1
        else:
            self._confirmed_out   += 1
            self._confirmed_total += 1
        bucket = self._counts.setdefault(cls_name, {"in": 0, "out": 0})
        bucket["in" if direction_in else "out"] += 1

    # ── position-based deduplication ─────────────────────────────────────────

    def _is_pos_duplicate(self, cx: float, cy: float) -> bool:
        """Return True if a recently counted vehicle was within DEDUP_RADIUS of (cx, cy).

        Handles two double-counting sources:
        1. YOLO dual-class detection (car + truck same vehicle → two overlapping boxes).
        2. Tracker ID flip: ByteTrack assigns a new ID to the same vehicle while still
           inside the trip-wire, causing the new ID to pass the _confirmed_ids check.
        """
        now = time.monotonic()
        diag = (self.frame_width ** 2 + self.frame_height ** 2) ** 0.5
        max_d = diag * DEDUP_RADIUS_RATIO
        self._recent_count_pos = [
            (x, y, t) for x, y, t in self._recent_count_pos if now - t < DEDUP_TTL_SEC
        ]
        return any(
            ((cx - x) ** 2 + (cy - y) ** 2) ** 0.5 < max_d
            for x, y, t in self._recent_count_pos
        )

    # ── eligibility filter ────────────────────────────────────────────────────

    # ── pixel-level line intersection helpers ─────────────────────────────────

    @staticmethod
    def _segs_intersect(
        ax1: float, ay1: float, ax2: float, ay2: float,
        bx1: float, by1: float, bx2: float, by2: float,
    ) -> bool:
        """Return True if line segment A intersects line segment B."""
        def cross(ox, oy, ax, ay, bx, by):
            return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox)
        def on_seg(px, py, qx, qy, rx, ry):
            return min(px, rx) <= qx <= max(px, rx) and min(py, ry) <= qy <= max(py, ry)
        d1 = cross(bx1, by1, bx2, by2, ax1, ay1)
        d2 = cross(bx1, by1, bx2, by2, ax2, ay2)
        d3 = cross(ax1, ay1, ax2, ay2, bx1, by1)
        d4 = cross(ax1, ay1, ax2, ay2, bx2, by2)
        if ((d1 > 0 and d2 < 0) or (d1 < 0 and d2 > 0)) and \
           ((d3 > 0 and d4 < 0) or (d3 < 0 and d4 > 0)):
            return True
        if d1 == 0 and on_seg(bx1, by1, ax1, ay1, bx2, by2): return True
        if d2 == 0 and on_seg(bx1, by1, ax2, ay2, bx2, by2): return True
        if d3 == 0 and on_seg(ax1, ay1, bx1, by1, ax2, ay2): return True
        if d4 == 0 and on_seg(ax1, ay1, bx2, by2, ax2, ay2): return True
        return False

    def _bbox_hits_line(self, bx1: float, by1: float, bx2: float, by2: float) -> bool:
        """Return True if the axis-aligned bounding box touches the count line segment."""
        if self._line_seg is None:
            return False
        lx1, ly1, lx2, ly2 = self._line_seg
        # Check all 4 sides of the bbox against the line
        sides = [
            (bx1, by1, bx2, by1),  # top
            (bx2, by1, bx2, by2),  # right
            (bx2, by2, bx1, by2),  # bottom
            (bx1, by2, bx1, by1),  # left
        ]
        for sx1, sy1, sx2, sy2 in sides:
            if self._segs_intersect(lx1, ly1, lx2, ly2, sx1, sy1, sx2, sy2):
                return True
        # Line endpoint inside the bbox (covers fully-contained short lines)
        if bx1 <= lx1 <= bx2 and by1 <= ly1 <= by2:
            return True
        if bx1 <= lx2 <= bx2 and by1 <= ly2 <= by2:
            return True
        return False

    def _eligible_mask(self, detections: sv.Detections) -> list[bool]:
        n           = len(detections)
        mask        = [True] * n
        s           = self._settings
        min_conf    = float(s.get("min_confidence", 0.22))
        min_area    = float(s.get("min_box_area_ratio", 0.001))
        cls_floor   = s.get("class_min_confidence", {})
        allowed     = s.get("allowed_classes", [])
        unk_as_car  = bool(s.get("count_unknown_as_car", True))
        frame_area  = float(max(1, self.frame_width * self.frame_height))

        for i in range(n):
            cls_id   = int(detections.class_id[i]) if detections.class_id is not None else -1
            cls_name = CLASS_NAMES.get(cls_id, "unknown")
            if cls_name == "unknown":
                if unk_as_car:
                    cls_name = "car"
                else:
                    mask[i] = False
                    continue

            if allowed and cls_name not in allowed:
                mask[i] = False
                continue

            if detections.confidence is not None and i < len(detections.confidence):
                conf = float(detections.confidence[i])
                if conf < min_conf:
                    mask[i] = False
                    continue
                floor = cls_floor.get(cls_name)
                if floor is not None and conf < float(floor):
                    mask[i] = False
                    continue

            if detections.xyxy is not None and i < len(detections.xyxy):
                x1, y1, x2, y2 = detections.xyxy[i]
                area = (float(x2) - float(x1)) * (float(y2) - float(y1)) / frame_area
                if area < min_area:
                    mask[i] = False
                    continue

        # detect zone — inclusion filter: center must be INSIDE detect_zone polygon
        if self._detect_poly is not None and n > 0 and detections.xyxy is not None:
            for i in range(n):
                if not mask[i]:
                    continue
                if i >= len(detections.xyxy):
                    continue
                x1d, y1d, x2d, y2d = detections.xyxy[i]
                cx = float((x1d + x2d) / 2)
                cy = float((y1d + y2d) / 2)
                try:
                    if cv2.pointPolygonTest(self._detect_poly, (cx, cy), False) < 0:
                        mask[i] = False
                except Exception:
                    pass

        # exclusion zones — center-point-in-polygon (avoids BOTTOM_CENTER anchor issue)
        if self._excl_polys and n > 0 and detections.xyxy is not None:
            for i in range(n):
                if not mask[i]:
                    continue
                if i >= len(detections.xyxy):
                    continue
                x1e, y1e, x2e, y2e = detections.xyxy[i]
                cx = float((x1e + x2e) / 2)
                cy = float((y1e + y2e) / 2)
                for poly in self._excl_polys:
                    try:
                        if cv2.pointPolygonTest(poly, (cx, cy), False) >= 0:
                            mask[i] = False
                            break
                    except Exception:
                        pass

        return mask

    # ── main process ──────────────────────────────────────────────────────────

    async def process(self, frame: np.ndarray, detections: sv.Detections) -> dict[str, Any]:
        now_mono = time.monotonic()
        no_zone = self._zone is None and self._line_seg is None
        if no_zone or (now_mono - self._last_refresh) > LINE_REFRESH_INTERVAL:
            try:
                await self._refresh()
            except Exception as exc:
                logger.warning("Counter._refresh failed: %s", exc)

        if self._zone is None and self._line_seg is None:
            return self._empty_snapshot()

        has_ids = (
            detections.tracker_id is not None
            and len(detections.tracker_id) == len(detections)
        )
        tracker_ids: list[int] = []
        if has_ids:
            tracker_ids = [int(t) for t in detections.tracker_id]

        # eligibility
        eligible = self._eligible_mask(detections)

        # touch tracks
        if has_ids:
            for i, tid in enumerate(tracker_ids):
                self._touch(tid)
            self._cleanup()

        # build filtered subset for zone trigger
        eligible_indices = [i for i, ok in enumerate(eligible) if ok]
        new_crossings    = 0
        crossing_events: list[dict] = []
        min_tf           = int(self._settings.get("min_track_frames", 2))

        s           = self._settings
        unk_as_car  = bool(s.get("count_unknown_as_car", True))

        self._process_calls += 1
        do_diag = (self._process_calls % 50 == 1)  # log every 50 calls (~12 min at 1/15s)

        if self._zone_type == "line":
            # LineZone: use sv.LineZone.trigger which tracks crossed_in/crossed_out
            if len(detections) > 0:
                try:
                    crossed_in, crossed_out = self._zone.trigger(detections=detections)
                except Exception as e:
                    logger.warning("LineZone.trigger failed: %s", e)
                    crossed_in = crossed_out = np.array([], dtype=bool)

                # ── diagnostic log ──────────────────────────────────────────
                if do_diag and detections.xyxy is not None:
                    lx1, ly1, lx2, ly2 = self._zone_coords
                    centers = []
                    for i in range(min(len(detections.xyxy), 8)):
                        bx1, by1, bx2, by2 = detections.xyxy[i]
                        cx = (float(bx1) + float(bx2)) / 2
                        cy = (float(by1) + float(by2)) / 2
                        tf = self._track_frames.get(tracker_ids[i] if has_ids and i < len(tracker_ids) else -1, 0)
                        ci = bool(crossed_in[i]) if i < len(crossed_in) else False
                        co = bool(crossed_out[i]) if i < len(crossed_out) else False
                        elig = i in eligible_indices
                        centers.append(f"({cx/self.frame_width:.2f},{cy/self.frame_height:.2f})tf={tf}e={elig}ci={ci}co={co}")
                    logger.info(
                        "DIAG frame=%dx%d line=(%d,%d)->(%d,%d) rel=(%.2f,%.2f)->(%.2f,%.2f) "
                        "n=%d eligible=%d pending=%d det=%s",
                        self.frame_width, self.frame_height,
                        int(lx1), int(ly1), int(lx2), int(ly2),
                        lx1/self.frame_width, ly1/self.frame_height,
                        lx2/self.frame_width, ly2/self.frame_height,
                        len(detections), len(eligible_indices),
                        len(self._pending_crossings),
                        " ".join(centers),
                    )
                # ────────────────────────────────────────────────────────────

                for i in eligible_indices:
                    if i >= len(crossed_in):
                        continue
                    tid = tracker_ids[i] if has_ids and i < len(tracker_ids) else None
                    if tid is not None and tid in self._confirmed_ids:
                        continue

                    cls_id   = int(detections.class_id[i]) if detections.class_id is not None else -1
                    cls_name = CLASS_NAMES.get(cls_id, "unknown")
                    if cls_name == "unknown" and unk_as_car:
                        cls_name = "car"

                    direction_in: bool | None = None
                    if crossed_in[i]:
                        direction_in = True
                    elif crossed_out[i]:
                        direction_in = False

                    if direction_in is not None:
                        frames_seen = self._track_frames.get(tid, 0) if tid is not None else min_tf
                        if frames_seen >= min_tf:
                            # Immediately count — track is mature enough.
                            self._add_count(cls_name, direction_in)
                            new_crossings += 1
                            conf = round(float(detections.confidence[i]), 4) if detections.confidence is not None and i < len(detections.confidence) else None
                            crossing_events.append({
                                "camera_id": self.camera_id,
                                "captured_at": datetime.now(timezone.utc).isoformat(),
                                "track_id": int(tid) if tid is not None else None,
                                "vehicle_class": cls_name,
                                "confidence": conf,
                                "direction": "in" if direction_in else "out",
                                "scene_lighting": self._scene_status.get("scene_lighting"),
                                "scene_weather": self._scene_status.get("scene_weather"),
                                "zone_source": "game",
                                "zone_name": self._zone_name,
                            })
                            if tid is not None:
                                self._confirmed_ids.add(tid)
                                self._pending_crossings.pop(tid, None)
                        elif tid is not None and tid not in self._pending_crossings:
                            # Track crossed but not mature yet — queue it.
                            self._pending_crossings[tid] = direction_in
                            logger.info(
                                "Crossing queued: tid=%d frames=%d/%d cls=%s dir=%s",
                                tid, frames_seen, min_tf, cls_name,
                                "in" if direction_in else "out",
                            )

                # ── flush pending crossings for now-mature tracks ────────────
                if self._pending_crossings and has_ids:
                    for tid, direction_in in list(self._pending_crossings.items()):
                        if tid in self._confirmed_ids:
                            del self._pending_crossings[tid]
                            continue
                        if self._track_frames.get(tid, 0) >= min_tf:
                            # Find class for this tid
                            cls_name = "car"
                            for i, t in enumerate(tracker_ids):
                                if t == tid and detections.class_id is not None and i < len(detections.class_id):
                                    c = CLASS_NAMES.get(int(detections.class_id[i]), "unknown")
                                    cls_name = c if c != "unknown" else ("car" if unk_as_car else "unknown")
                                    break
                            self._add_count(cls_name, direction_in)
                            new_crossings += 1
                            self._confirmed_ids.add(tid)
                            del self._pending_crossings[tid]
                            _pconf = None
                            for ii, t in enumerate(tracker_ids):
                                if t == tid and detections.confidence is not None and ii < len(detections.confidence):
                                    _pconf = round(float(detections.confidence[ii]), 4)
                                    break
                            crossing_events.append({
                                "camera_id": self.camera_id,
                                "captured_at": datetime.now(timezone.utc).isoformat(),
                                "track_id": int(tid),
                                "vehicle_class": cls_name,
                                "confidence": _pconf,
                                "direction": "in" if direction_in else "out",
                                "scene_lighting": self._scene_status.get("scene_lighting"),
                                "scene_weather": self._scene_status.get("scene_weather"),
                                "zone_source": "game",
                                "zone_name": self._zone_name,
                            })
                            logger.info(
                                "Pending crossing flushed: tid=%d cls=%s dir=%s total=%d",
                                tid, cls_name, "in" if direction_in else "out",
                                self._confirmed_total,
                            )

        elif self._zone_type == "line_pixel":
            # Pixel-level bbox intersection: count any detection whose bounding
            # box touches the drawn line segment.  No trip-wire band — any pixel
            # of the box overlapping the line is sufficient to trigger.
            if len(detections) > 0 and detections.xyxy is not None:
                for i in eligible_indices:
                    if i >= len(detections.xyxy):
                        continue
                    bx1, by1, bx2, by2 = detections.xyxy[i]
                    if not self._bbox_hits_line(float(bx1), float(by1), float(bx2), float(by2)):
                        continue

                    tid = tracker_ids[i] if has_ids and i < len(tracker_ids) else None

                    # Untracked: use position dedup only
                    if tid is None:
                        cx_u = (float(bx1) + float(bx2)) / 2
                        cy_u = (float(by1) + float(by2)) / 2
                        if not self._is_pos_duplicate(cx_u, cy_u):
                            cls_id_u = int(detections.class_id[i]) if detections.class_id is not None and i < len(detections.class_id) else -1
                            cls_u = CLASS_NAMES.get(cls_id_u, "unknown")
                            if cls_u == "unknown" and unk_as_car:
                                cls_u = "car"
                            if cls_u and cls_u != "unknown":
                                self._add_count(cls_u, True)
                                new_crossings += 1
                                self._recent_count_pos.append((cx_u, cy_u, time.monotonic()))
                                conf_u = round(float(detections.confidence[i]), 4) if detections.confidence is not None and i < len(detections.confidence) else None
                                crossing_events.append({
                                    "camera_id": self.camera_id, "captured_at": datetime.now(timezone.utc).isoformat(),
                                    "track_id": None, "vehicle_class": cls_u, "confidence": conf_u,
                                    "direction": "in",
                                    "scene_lighting": self._scene_status.get("scene_lighting"),
                                    "scene_weather": self._scene_status.get("scene_weather"),
                                    "zone_source": "game", "zone_name": self._zone_name,
                                })
                        continue

                    if tid in self._confirmed_ids:
                        continue

                    frames_seen = self._track_frames.get(tid, 0) if tid is not None else min_tf
                    if frames_seen < min_tf:
                        if tid not in self._pending_crossings:
                            self._pending_crossings[tid] = True
                        continue

                    cx = (float(bx1) + float(bx2)) / 2
                    cy = (float(by1) + float(by2)) / 2
                    if self._is_pos_duplicate(cx, cy):
                        self._confirmed_ids.add(tid)
                        continue

                    cls_id = int(detections.class_id[i]) if detections.class_id is not None and i < len(detections.class_id) else -1
                    cls_name = CLASS_NAMES.get(cls_id, "unknown")
                    if cls_name == "unknown" and unk_as_car:
                        cls_name = "car"
                    if not cls_name or cls_name == "unknown":
                        continue

                    self._add_count(cls_name, True)
                    self._confirmed_ids.add(tid)
                    new_crossings += 1
                    self._recent_count_pos.append((cx, cy, time.monotonic()))
                    conf = round(float(detections.confidence[i]), 4) if detections.confidence is not None and i < len(detections.confidence) else None
                    crossing_events.append({
                        "camera_id": self.camera_id, "captured_at": datetime.now(timezone.utc).isoformat(),
                        "track_id": int(tid), "vehicle_class": cls_name, "confidence": conf,
                        "direction": "in",
                        "scene_lighting": self._scene_status.get("scene_lighting"),
                        "scene_weather": self._scene_status.get("scene_weather"),
                        "zone_source": "game", "zone_name": self._zone_name,
                    })

                # Flush pending crossings for mature tracks
                if self._pending_crossings and has_ids:
                    for tid, _ in list(self._pending_crossings.items()):
                        if tid in self._confirmed_ids:
                            del self._pending_crossings[tid]
                            continue
                        if self._track_frames.get(tid, 0) < min_tf:
                            continue
                        cls_name = "car"
                        for i, t in enumerate(tracker_ids):
                            if t == tid and detections.class_id is not None and i < len(detections.class_id):
                                c = CLASS_NAMES.get(int(detections.class_id[i]), "unknown")
                                cls_name = c if c != "unknown" else ("car" if unk_as_car else "unknown")
                                break
                        self._add_count(cls_name, True)
                        self._confirmed_ids.add(tid)
                        new_crossings += 1
                        del self._pending_crossings[tid]
                        _pconf = None
                        for ii, t in enumerate(tracker_ids):
                            if t == tid and detections.confidence is not None and ii < len(detections.confidence):
                                _pconf = round(float(detections.confidence[ii]), 4)
                                break
                        crossing_events.append({
                            "camera_id": self.camera_id, "captured_at": datetime.now(timezone.utc).isoformat(),
                            "track_id": int(tid), "vehicle_class": cls_name, "confidence": _pconf,
                            "direction": "in",
                            "scene_lighting": self._scene_status.get("scene_lighting"),
                            "scene_weather": self._scene_status.get("scene_weather"),
                            "zone_source": "game", "zone_name": self._zone_name,
                        })
                        logger.info("line_pixel pending flushed: tid=%d cls=%s total=%d", tid, cls_name, self._confirmed_total)

        else:  # polygon
            if len(detections) > 0:
                try:
                    inside_mask = self._zone.trigger(detections=detections)
                except Exception:
                    inside_mask = np.zeros(len(detections), dtype=bool)

                inside_now: set[int] = set()
                tid_to_center: dict[int, tuple[float, float]] = {}

                for i in eligible_indices:
                    if i >= len(inside_mask) or not inside_mask[i]:
                        continue
                    tid = tracker_ids[i] if has_ids and i < len(tracker_ids) else None

                    # ── untracked detection fallback ──────────────────────────
                    # ByteTrack may fail to assign an ID on choppy streams.
                    # Count untracked detections via position-dedup only — no
                    # _confirmed_ids check (no ID to check), no min_track_frames.
                    if tid is None:
                        if detections.xyxy is not None and i < len(detections.xyxy):
                            x1u, y1u, x2u, y2u = detections.xyxy[i]
                            cu = (float((x1u + x2u) / 2), float((y1u + y2u) / 2))
                            if not self._is_pos_duplicate(cu[0], cu[1]):
                                cls_id_u = int(detections.class_id[i]) if detections.class_id is not None and i < len(detections.class_id) else -1
                                cls_u = CLASS_NAMES.get(cls_id_u, "unknown")
                                if cls_u == "unknown":
                                    cls_u = "car" if unk_as_car else None
                                if cls_u:
                                    self._add_count(cls_u, True)
                                    new_crossings += 1
                                    self._recent_count_pos.append((cu[0], cu[1], time.monotonic()))
                                    conf_u = round(float(detections.confidence[i]), 4) if detections.confidence is not None and i < len(detections.confidence) else None
                                    crossing_events.append({
                                        "camera_id": self.camera_id,
                                        "captured_at": datetime.now(timezone.utc).isoformat(),
                                        "track_id": None,
                                        "vehicle_class": cls_u,
                                        "confidence": conf_u,
                                        "direction": "in",
                                        "scene_lighting": self._scene_status.get("scene_lighting"),
                                        "scene_weather": self._scene_status.get("scene_weather"),
                                        "zone_source": "game",
                                        "zone_name": self._zone_name,
                                    })
                        continue

                    if tid in self._confirmed_ids:
                        continue

                    if detections.xyxy is not None and i < len(detections.xyxy):
                        x1b, y1b, x2b, y2b = detections.xyxy[i]
                        tid_to_center[tid] = (float((x1b + x2b) / 2), float((y1b + y2b) / 2))

                    if self._track_frames.get(tid, 0) < min_tf:
                        # Track is inside zone but not mature yet — queue it.
                        # Will be flushed as soon as the track accumulates enough frames,
                        # even if the vehicle has already exited the trip-wire by then.
                        if tid not in self._pending_crossings:
                            self._pending_crossings[tid] = True
                        inside_now.add(tid)
                        continue

                    inside_now.add(tid)

                # count tracks that just entered (were outside last frame, inside now)
                newly_entered = inside_now - self._inside_ids
                for tid in newly_entered:
                    if self._track_frames.get(tid, 0) < min_tf:
                        continue  # still immature, pending queue handles it
                    # Position-based dedup: suppress tracker ID flips and dual-class
                    # detections that refer to the same physical vehicle.
                    center = tid_to_center.get(tid)
                    if center and self._is_pos_duplicate(center[0], center[1]):
                        self._confirmed_ids.add(tid)  # mark so it's never counted
                        continue

                    # find class for this tid
                    cls_name = "car"
                    if has_ids:
                        for i, t in enumerate(tracker_ids):
                            if t == tid and detections.class_id is not None and i < len(detections.class_id):
                                c = CLASS_NAMES.get(int(detections.class_id[i]), "unknown")
                                cls_name = c if c != "unknown" else ("car" if unk_as_car else "unknown")
                                break
                    if cls_name == "unknown":
                        continue
                    self._add_count(cls_name, True)
                    self._confirmed_ids.add(tid)
                    new_crossings += 1
                    if center:
                        self._recent_count_pos.append((center[0], center[1], time.monotonic()))
                    _pconf = None
                    if has_ids:
                        for ii, t in enumerate(tracker_ids):
                            if t == tid and detections.confidence is not None and ii < len(detections.confidence):
                                _pconf = round(float(detections.confidence[ii]), 4)
                                break
                    crossing_events.append({
                        "camera_id": self.camera_id,
                        "captured_at": datetime.now(timezone.utc).isoformat(),
                        "track_id": int(tid),
                        "vehicle_class": cls_name,
                        "confidence": _pconf,
                        "direction": "in",
                        "scene_lighting": self._scene_status.get("scene_lighting"),
                        "scene_weather": self._scene_status.get("scene_weather"),
                        "zone_source": "game",
                        "zone_name": self._zone_name,
                    })

                self._inside_ids = inside_now

                # ── flush pending polygon entries for now-mature tracks ────
                # These are vehicles that entered the zone but didn't have enough
                # track frames at entry time. Count them now regardless of whether
                # they're still inside the zone (they crossed, just late to confirm).
                if self._pending_crossings and has_ids:
                    for tid, _ in list(self._pending_crossings.items()):
                        if tid in self._confirmed_ids:
                            del self._pending_crossings[tid]
                            continue
                        if self._track_frames.get(tid, 0) < min_tf:
                            continue
                        center = tid_to_center.get(tid)
                        if center and self._is_pos_duplicate(center[0], center[1]):
                            self._confirmed_ids.add(tid)
                            del self._pending_crossings[tid]
                            continue
                        cls_name = "car"
                        if has_ids:
                            for i, t in enumerate(tracker_ids):
                                if t == tid and detections.class_id is not None and i < len(detections.class_id):
                                    c = CLASS_NAMES.get(int(detections.class_id[i]), "unknown")
                                    cls_name = c if c != "unknown" else ("car" if unk_as_car else "unknown")
                                    break
                        if cls_name == "unknown":
                            del self._pending_crossings[tid]
                            continue
                        self._add_count(cls_name, True)
                        self._confirmed_ids.add(tid)
                        new_crossings += 1
                        if center:
                            self._recent_count_pos.append((center[0], center[1], time.monotonic()))
                        _pconf = None
                        if has_ids:
                            for ii, t in enumerate(tracker_ids):
                                if t == tid and detections.confidence is not None and ii < len(detections.confidence):
                                    _pconf = round(float(detections.confidence[ii]), 4)
                                    break
                        crossing_events.append({
                            "camera_id": self.camera_id,
                            "captured_at": datetime.now(timezone.utc).isoformat(),
                            "track_id": int(tid),
                            "vehicle_class": cls_name,
                            "confidence": _pconf,
                            "direction": "in",
                            "scene_lighting": self._scene_status.get("scene_lighting"),
                            "scene_weather": self._scene_status.get("scene_weather"),
                            "zone_source": "game",
                            "zone_name": self._zone_name,
                        })
                        del self._pending_crossings[tid]
                        logger.info(
                            "Polygon pending flushed: tid=%d cls=%s total=%d",
                            tid, cls_name, self._confirmed_total,
                        )

        # ── secondary detect-zone fallback counter ────────────────────────────
        # Any eligible tracker that newly enters the detect_zone polygon and
        # hasn't already been counted by the trip-wire gets counted here.
        # Acts as a pre-count: cars on approach are caught before reaching the
        # line, so bad-stream frame drops at the line don't cause misses.
        # _confirmed_ids prevents double-counting — if the trip-wire already
        # counted this vehicle, the detect-zone path is silently skipped.
        if self._detect_zone_sv is not None and len(detections) > 0 and has_ids:
            try:
                dz_inside = self._detect_zone_sv.trigger(detections=detections)
            except Exception:
                dz_inside = np.zeros(len(detections), dtype=bool)

            dz_inside_now: set[int] = set()
            dz_tid_center: dict[int, tuple[float, float]] = {}

            for i in eligible_indices:
                if i >= len(dz_inside) or not dz_inside[i]:
                    continue
                dz_tid = tracker_ids[i] if i < len(tracker_ids) else None
                if dz_tid is None or dz_tid in self._confirmed_ids:
                    continue
                dz_inside_now.add(dz_tid)
                if detections.xyxy is not None and i < len(detections.xyxy):
                    x1z, y1z, x2z, y2z = detections.xyxy[i]
                    dz_tid_center[dz_tid] = (float((x1z + x2z) / 2), float((y1z + y2z) / 2))

            dz_newly_entered = dz_inside_now - self._detect_inside_ids
            for dz_tid in dz_newly_entered:
                if dz_tid in self._confirmed_ids:
                    continue
                if self._track_frames.get(dz_tid, 0) < min_tf:
                    # Queue in pending — will be counted when track matures
                    if dz_tid not in self._pending_crossings:
                        self._pending_crossings[dz_tid] = True
                    continue
                dz_center = dz_tid_center.get(dz_tid)
                if dz_center and self._is_pos_duplicate(dz_center[0], dz_center[1]):
                    self._confirmed_ids.add(dz_tid)
                    continue
                dz_cls = "car"
                for i, t in enumerate(tracker_ids):
                    if t == dz_tid and detections.class_id is not None and i < len(detections.class_id):
                        c = CLASS_NAMES.get(int(detections.class_id[i]), "unknown")
                        dz_cls = c if c != "unknown" else ("car" if unk_as_car else "unknown")
                        break
                if dz_cls == "unknown":
                    continue
                self._add_count(dz_cls, True)
                self._confirmed_ids.add(dz_tid)
                new_crossings += 1
                if dz_center:
                    self._recent_count_pos.append((dz_center[0], dz_center[1], time.monotonic()))
                dz_conf = None
                for ii, t in enumerate(tracker_ids):
                    if t == dz_tid and detections.confidence is not None and ii < len(detections.confidence):
                        dz_conf = round(float(detections.confidence[ii]), 4)
                        break
                crossing_events.append({
                    "camera_id":      self.camera_id,
                    "captured_at":    datetime.now(timezone.utc).isoformat(),
                    "track_id":       int(dz_tid),
                    "vehicle_class":  dz_cls,
                    "confidence":     dz_conf,
                    "direction":      "in",
                    "scene_lighting": self._scene_status.get("scene_lighting"),
                    "scene_weather":  self._scene_status.get("scene_weather"),
                    "zone_source":    "game",
                    "zone_name":      self._zone_name,
                })
                logger.debug("Detect-zone pre-count: tid=%d cls=%s total=%d", dz_tid, dz_cls, self._confirmed_total)

            self._detect_inside_ids = dz_inside_now

        # Attach color to all crossing events using the current frame
        if frame is not None and detections.xyxy is not None:
            tid_to_bbox: dict[int, tuple] = {}
            if has_ids:
                for i, tid in enumerate(tracker_ids):
                    if i < len(detections.xyxy):
                        tid_to_bbox[tid] = tuple(detections.xyxy[i])
            for ev in crossing_events:
                if ev.get("color"):
                    continue
                tid_ev = ev.get("track_id")
                bbox = tid_to_bbox.get(tid_ev) if tid_ev is not None else None
                if bbox:
                    ev["color"] = _sample_vehicle_color(frame, int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3]))

        # build snapshot
        breakdown = {cls: v["in"] + v["out"] for cls, v in self._counts.items()}

        # detection boxes for WS broadcast — show ALL detections.
        # in_detect_zone=True  → inside the detect polygon (or no polygon configured)
        # in_detect_zone=False → outside the detect polygon (background / context only)
        # Frontend renders these differently: full-colour vs dimmed/dashed box.
        boxes: list[dict] = []
        if len(detections) > 0 and detections.xyxy is not None:
            for i in range(min(len(detections.xyxy), 60)):
                cls_id = int(detections.class_id[i]) if detections.class_id is not None and i < len(detections.class_id) else -1
                if cls_id not in CLASS_NAMES:
                    continue
                # Require at least minimum global confidence for display (halved vs counting threshold)
                if detections.confidence is not None and i < len(detections.confidence):
                    if float(detections.confidence[i]) < max(0.10, self._settings.get("min_confidence", 0.22) * 0.5):
                        continue
                conf = round(float(detections.confidence[i]), 4) if detections.confidence is not None and i < len(detections.confidence) else None
                x1, y1, x2, y2 = detections.xyxy[i]
                in_dz = (self._detect_poly is None) or (i < len(eligible) and eligible[i])
                color = _sample_vehicle_color(frame, int(x1), int(y1), int(x2), int(y2))
                boxes.append({
                    "x1": round(float(x1) / self.frame_width, 4),
                    "y1": round(float(y1) / self.frame_height, 4),
                    "x2": round(float(x2) / self.frame_width, 4),
                    "y2": round(float(y2) / self.frame_height, 4),
                    "cls": CLASS_NAMES[cls_id],
                    "conf": conf,
                    "color": color,
                    "in_detect_zone": in_dz,
                })

        return {
            "camera_id":              self.camera_id,
            "captured_at":            datetime.now(timezone.utc).isoformat(),
            "count_in":               self._confirmed_in,
            "count_out":              self._confirmed_out,
            "total":                  self._confirmed_total,
            "vehicle_breakdown":      breakdown,
            "round_count_in":         max(0, self._confirmed_in  - self._round_in),
            "round_count_out":        max(0, self._confirmed_out - self._round_out),
            "round_total":            max(0, self._confirmed_total - self._round_total),
            "round_vehicle_breakdown": {
                cls: max(0, int(v) - int(self._round_cls.get(cls, 0)))
                for cls, v in breakdown.items()
            },
            "detections":             boxes,
            "new_crossings":          new_crossings,
            "crossing_events":        crossing_events,
            "per_class_total":        {cls: v["in"] + v["out"] for cls, v in self._counts.items()},
            "pre_count_total":        0,
            "confirmed_crossings_total": self._confirmed_total,
            "burst_mode_active":      False,
        }

    def _empty_snapshot(self) -> dict[str, Any]:
        return {
            "camera_id": self.camera_id,
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "count_in": self._confirmed_in, "count_out": self._confirmed_out,
            "total": self._confirmed_total, "vehicle_breakdown": {},
            "round_count_in": 0, "round_count_out": 0, "round_total": 0,
            "round_vehicle_breakdown": {}, "detections": [], "new_crossings": 0,
            "per_class_total": {}, "pre_count_total": 0,
            "confirmed_crossings_total": self._confirmed_total,
            "burst_mode_active": False,
        }

    # ── helpers used by main.py ───────────────────────────────────────────────

    def set_scene_status(self, scene: dict[str, Any]) -> None:
        self._scene_status = scene or {}

    def get_setting(self, key: str, default: Any = None) -> Any:
        return self._settings.get(key, default)

    def reset_round(self) -> None:
        self._round_in    = self._confirmed_in
        self._round_out   = self._confirmed_out
        self._round_total = self._confirmed_total
        self._round_cls   = {cls: v["in"] + v["out"] for cls, v in self._counts.items()}

    async def bootstrap_from_latest_snapshot(self) -> None:
        """Restore confirmed_total from the latest DB snapshot on startup."""
        try:
            sb = await get_supabase()
            resp = await (
                sb.table("count_snapshots")
                .select("total, vehicle_breakdown")
                .eq("camera_id", self.camera_id)
                .order("captured_at", desc=True)
                .limit(1)
                .execute()
            )
            rows = resp.data or []
            if rows:
                snap = rows[0]
                total = int(snap.get("total") or 0)
                self._confirmed_total = total
                self._confirmed_in    = total
                bd = snap.get("vehicle_breakdown") or {}
                if isinstance(bd, dict):
                    for cls, cnt in bd.items():
                        self._counts[cls] = {"in": int(cnt), "out": 0}
                logger.info("Counter bootstrapped: total=%d camera=%s", total, self.camera_id)
        except Exception as exc:
            logger.warning("Counter bootstrap failed: %s", exc)


async def write_snapshot(snapshot: dict) -> None:
    """Write a count snapshot row to Supabase. Called by main.py at DB_SNAPSHOT_INTERVAL_SEC."""
    try:
        sb = await get_supabase()
        row = {
            "camera_id":         snapshot.get("camera_id"),
            "captured_at":       snapshot.get("captured_at"),
            "total":             snapshot.get("total", 0),
            "count_in":          snapshot.get("count_in", 0),
            "count_out":         snapshot.get("count_out", 0),
            "vehicle_breakdown": snapshot.get("vehicle_breakdown", {}),
            "round_total":       snapshot.get("round_total", 0),
            "round_count_in":    snapshot.get("round_count_in", 0),
            "round_count_out":   snapshot.get("round_count_out", 0),
        }
        await sb.table("count_snapshots").insert(row).execute()
    except Exception as exc:
        logger.warning("write_snapshot failed: %s", exc)


async def write_vehicle_crossings(events: list[dict]) -> None:
    """Write per-vehicle crossing rows to Supabase. Called by main.py on each frame."""
    if not events:
        return
    try:
        sb = await get_supabase()
        await sb.table("vehicle_crossings").insert(events).execute()
    except Exception as exc:
        logger.warning("write_vehicle_crossings failed (%d events): %s", len(events), exc)


# ── Analytics zone processor stub (keeps analytics_service import happy) ──────

class AnalyticsZoneProcessor:
    """Stub — zone analytics handled by analytics_service separately."""
    def __init__(self, *a, **kw): pass
    def process(self, *a, **kw) -> list: return []
