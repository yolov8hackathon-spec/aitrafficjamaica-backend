-- ─────────────────────────────────────────────────────────────────────────────
-- WHITELINEZ — Supabase Schema
-- Run this in the Supabase SQL editor (Project → SQL Editor → New query)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Tables ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cameras (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  ipcam_alias  TEXT UNIQUE,                  -- ipcamlive camera alias (e.g. "abc123")
  stream_url   TEXT NOT NULL DEFAULT '',     -- refreshed every ~4min by url_refresh_loop
  count_line   JSONB,                        -- {x1,y1,x2,y2} as 0–1 relative coords
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- Camera AI/counter config (migration-safe additions for older projects).
ALTER TABLE cameras
  ADD COLUMN IF NOT EXISTS detect_zone JSONB, -- polygon points used for pre-validation
  ADD COLUMN IF NOT EXISTS count_settings JSONB NOT NULL DEFAULT '{}', -- per-camera thresholds
  ADD COLUMN IF NOT EXISTS feed_appearance JSONB NOT NULL DEFAULT '{}'; -- admin/public video appearance

-- Preset A defaults for new cameras.
ALTER TABLE cameras
  ALTER COLUMN count_settings SET DEFAULT
  '{
    "min_track_frames": 3,
    "min_box_area_ratio": 0.0015,
    "min_confidence": 0.22,
    "allowed_classes": ["car", "truck", "bus", "motorcycle"],
    "class_min_confidence": {"car": 0.20, "truck": 0.28, "bus": 0.30, "motorcycle": 0.22},
    "count_unknown_as_car": true
  }'::jsonb;

ALTER TABLE cameras
  ALTER COLUMN feed_appearance SET DEFAULT
  '{
    "detection_overlay": {
      "box_style": "solid",
      "line_width": 2,
      "fill_alpha": 0.10,
      "max_boxes": 10,
      "show_labels": true,
      "detect_zone_only": true,
      "outside_scan_enabled": true,
      "outside_scan_min_conf": 0.45,
      "outside_scan_max_boxes": 25,
      "outside_scan_hold_ms": 220,
      "outside_scan_show_labels": true,
      "ground_overlay_enabled": true,
      "ground_overlay_alpha": 0.16,
      "ground_grid_density": 6,
      "ground_occlusion_cutout": 0.38,
      "ground_quad": {"x1": 0.34, "y1": 0.58, "x2": 0.78, "y2": 0.58, "x3": 0.98, "y3": 0.98, "x4": 0.08, "y4": 0.98}
    }
  }'::jsonb;

-- Backfill existing cameras still on empty JSON defaults.
UPDATE cameras
SET count_settings = '{
  "min_track_frames": 3,
  "min_box_area_ratio": 0.0015,
  "min_confidence": 0.22,
  "allowed_classes": ["car", "truck", "bus", "motorcycle"],
  "class_min_confidence": {"car": 0.20, "truck": 0.28, "bus": 0.30, "motorcycle": 0.22},
  "count_unknown_as_car": true
}'::jsonb
WHERE count_settings IS NULL OR count_settings = '{}'::jsonb;

UPDATE cameras
SET feed_appearance = '{
  "detection_overlay": {
    "box_style": "solid",
    "line_width": 2,
    "fill_alpha": 0.10,
    "max_boxes": 10,
    "show_labels": true,
    "detect_zone_only": true,
    "outside_scan_enabled": true,
    "outside_scan_min_conf": 0.45,
    "outside_scan_max_boxes": 25,
    "outside_scan_hold_ms": 220,
    "outside_scan_show_labels": true,
    "ground_overlay_enabled": true,
    "ground_overlay_alpha": 0.16,
    "ground_grid_density": 6,
    "ground_occlusion_cutout": 0.38,
    "ground_quad": {"x1": 0.34, "y1": 0.58, "x2": 0.78, "y2": 0.58, "x3": 0.98, "y3": 0.98, "x4": 0.08, "y4": 0.98}
  }
}'::jsonb
WHERE feed_appearance IS NULL OR feed_appearance = '{}'::jsonb;

-- Re-enable outer scan labels on existing camera appearance configs.
UPDATE cameras
SET feed_appearance = jsonb_set(
  COALESCE(feed_appearance, '{}'::jsonb),
  '{detection_overlay,outside_scan_show_labels}',
  'true'::jsonb,
  true
)
WHERE feed_appearance ? 'detection_overlay';

-- Ground projection overlay defaults for existing camera appearance configs.
UPDATE cameras
SET feed_appearance = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            COALESCE(feed_appearance, '{}'::jsonb),
            '{detection_overlay,ground_overlay_enabled}',
            COALESCE(feed_appearance #> '{detection_overlay,ground_overlay_enabled}', 'true'::jsonb),
            true
          ),
          '{detection_overlay,ground_overlay_alpha}',
          COALESCE(feed_appearance #> '{detection_overlay,ground_overlay_alpha}', '0.16'::jsonb),
          true
        ),
        '{detection_overlay,ground_grid_density}',
        COALESCE(feed_appearance #> '{detection_overlay,ground_grid_density}', '6'::jsonb),
        true
      ),
      '{detection_overlay,ground_occlusion_cutout}',
      COALESCE(feed_appearance #> '{detection_overlay,ground_occlusion_cutout}', '0.38'::jsonb),
      true
    ),
    '{detection_overlay,ground_quad}',
    COALESCE(
      feed_appearance #> '{detection_overlay,ground_quad}',
      '{"x1": 0.34, "y1": 0.58, "x2": 0.78, "y2": 0.58, "x3": 0.98, "y3": 0.98, "x4": 0.08, "y4": 0.98}'::jsonb
    ),
    true
  ),
  '{detection_overlay,outside_scan_show_labels}',
  COALESCE(feed_appearance #> '{detection_overlay,outside_scan_show_labels}', 'true'::jsonb),
  true
)
WHERE feed_appearance ? 'detection_overlay';

CREATE TABLE IF NOT EXISTS bet_rounds (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id    UUID REFERENCES cameras ON DELETE SET NULL,
  market_type  TEXT NOT NULL,              -- 'over_under' | 'vehicle_type'
  params       JSONB NOT NULL DEFAULT '{}',
  status       TEXT DEFAULT 'upcoming',   -- upcoming|open|locked|resolved|cancelled
  opens_at     TIMESTAMPTZ,
  closes_at    TIMESTAMPTZ,
  ends_at      TIMESTAMPTZ,
  result       JSONB,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS markets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id     UUID REFERENCES bet_rounds ON DELETE CASCADE,
  label        TEXT NOT NULL,
  outcome_key  TEXT NOT NULL,
  odds         NUMERIC(5,2) NOT NULL,
  total_staked INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID REFERENCES auth.users NOT NULL,
  round_id         UUID REFERENCES bet_rounds NOT NULL,
  market_id        UUID REFERENCES markets NOT NULL,
  amount           INT NOT NULL CHECK (amount > 0),
  potential_payout INT NOT NULL,
  status           TEXT DEFAULT 'pending',  -- pending|won|lost|cancelled
  placed_at        TIMESTAMPTZ DEFAULT now(),
  resolved_at      TIMESTAMPTZ,
  UNIQUE (user_id, market_id)
);

-- Bets schema evolution for market + exact-count live bets.
-- Keep migration-safe so older databases can be upgraded in place.
ALTER TABLE bets
  ADD COLUMN IF NOT EXISTS bet_type TEXT DEFAULT 'market',           -- market|exact_count
  ADD COLUMN IF NOT EXISTS baseline_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS actual_count INT,
  ADD COLUMN IF NOT EXISTS window_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS window_duration_sec INT,
  ADD COLUMN IF NOT EXISTS vehicle_class TEXT,
  ADD COLUMN IF NOT EXISTS exact_count INT;

-- Live exact-count bets are not tied to a specific market row.
ALTER TABLE bets
  ALTER COLUMN market_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS count_snapshots (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id         UUID REFERENCES cameras ON DELETE SET NULL,
  captured_at       TIMESTAMPTZ DEFAULT now(),
  count_in          INT DEFAULT 0,
  count_out         INT DEFAULT 0,
  total             INT DEFAULT 0,
  vehicle_breakdown JSONB
);

-- Public chat messages (guest + authenticated users).
CREATE TABLE IF NOT EXISTS messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES auth.users ON DELETE SET NULL,
  guest_id   TEXT,
  username   TEXT NOT NULL CHECK (length(username) BETWEEN 1 AND 32),
  content    TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 280),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS guest_id TEXT;

ALTER TABLE messages
  ALTER COLUMN user_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_created_at
  ON messages(created_at DESC);

-- Site view telemetry (guest + authenticated).
CREATE TABLE IF NOT EXISTS site_views (
  id          BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id     UUID REFERENCES auth.users ON DELETE SET NULL,
  guest_id    TEXT,
  page_path   TEXT NOT NULL CHECK (length(page_path) BETWEEN 1 AND 200),
  referrer    TEXT,
  user_agent  TEXT,
  session_id  TEXT,
  source      TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'vercel')),
  viewed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_views_viewed_at
  ON site_views(viewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_views_page_path
  ON site_views(page_path);
CREATE INDEX IF NOT EXISTS idx_site_views_guest_id
  ON site_views(guest_id);

-- Automated round sessions (admin schedules looping rounds)
CREATE TABLE IF NOT EXISTS round_sessions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id            UUID REFERENCES cameras ON DELETE CASCADE,
  status               TEXT NOT NULL DEFAULT 'active', -- active|stopped|completed
  market_type          TEXT NOT NULL,                  -- over_under|vehicle_count|vehicle_type
  threshold            INT,
  vehicle_class        TEXT,
  round_duration_min   INT NOT NULL,
  bet_cutoff_min       INT NOT NULL DEFAULT 1,
  interval_min         INT NOT NULL DEFAULT 0,
  session_duration_min INT NOT NULL,
  max_rounds           INT,
  created_rounds       INT NOT NULL DEFAULT 0,
  starts_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at              TIMESTAMPTZ NOT NULL,
  next_round_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ML telemetry + training pipeline tables
CREATE TABLE IF NOT EXISTS ml_detection_events (
  id                   BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  camera_id            UUID REFERENCES cameras ON DELETE SET NULL,
  captured_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  model_name           TEXT,
  model_conf_threshold NUMERIC(6,4),
  detections_count     INT NOT NULL DEFAULT 0,
  avg_confidence       NUMERIC(6,4),
  class_counts         JSONB NOT NULL DEFAULT '{}',
  new_crossings        INT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_detection_events_captured_at
  ON ml_detection_events(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_ml_detection_events_camera_time
  ON ml_detection_events(camera_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS ml_training_jobs (
  id                BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  job_type          TEXT NOT NULL,  -- export|train|promote|evaluate
  status            TEXT NOT NULL DEFAULT 'pending', -- pending|running|completed|failed|skipped
  provider          TEXT,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  params            JSONB NOT NULL DEFAULT '{}',
  metrics           JSONB NOT NULL DEFAULT '{}',
  artifact_manifest JSONB,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_training_jobs_created_at
  ON ml_training_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ml_training_jobs_type_status
  ON ml_training_jobs(job_type, status);

CREATE TABLE IF NOT EXISTS ml_model_registry (
  id              BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  model_name      TEXT NOT NULL,
  model_uri       TEXT NOT NULL,
  base_model      TEXT,
  training_job_id BIGINT REFERENCES ml_training_jobs(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'candidate', -- candidate|active|archived
  metrics         JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ml_model_registry_model_name
  ON ml_model_registry(model_name);
CREATE INDEX IF NOT EXISTS idx_ml_model_registry_status_promoted
  ON ml_model_registry(status, promoted_at DESC);

-- ── User balances ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_balances (
  user_id   UUID REFERENCES auth.users PRIMARY KEY,
  balance   INT  NOT NULL DEFAULT 1000 CHECK (balance >= 0)
);

ALTER TABLE user_balances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own_balance_select" ON user_balances;
CREATE POLICY "own_balance_select" ON user_balances
  FOR SELECT USING (auth.uid() = user_id);

-- ── Seed: default camera (required for AI loop to start) ─────────────────────
-- Set ipcam_alias to your ipcamlive camera alias (e.g. "5e8a2f9c1b3d4").

INSERT INTO cameras (name, ipcam_alias, stream_url, is_active)
VALUES ('Kingston Feed', NULL, '', TRUE)
ON CONFLICT DO NOTHING;

-- ── Row Level Security ────────────────────────────────────────────────────────

ALTER TABLE cameras          ENABLE ROW LEVEL SECURITY;
ALTER TABLE bet_rounds       ENABLE ROW LEVEL SECURITY;
ALTER TABLE markets          ENABLE ROW LEVEL SECURITY;
ALTER TABLE bets             ENABLE ROW LEVEL SECURITY;
ALTER TABLE count_snapshots  ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages         ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_views       ENABLE ROW LEVEL SECURITY;
ALTER TABLE round_sessions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_detection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_training_jobs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_model_registry   ENABLE ROW LEVEL SECURITY;

-- Cameras: public read, admin write
DROP POLICY IF EXISTS "public_read_cameras"  ON cameras;
DROP POLICY IF EXISTS "admin_write_cameras"  ON cameras;
CREATE POLICY "public_read_cameras" ON cameras
  FOR SELECT USING (true);
CREATE POLICY "admin_write_cameras" ON cameras
  FOR ALL USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

-- Keep stream origin private from anon/authenticated roles.
-- Backend jobs and service role continue to read this column.
REVOKE SELECT (stream_url) ON TABLE cameras FROM anon, authenticated;

-- Bet rounds: public read, service role write (backend only)
DROP POLICY IF EXISTS "public_read_rounds" ON bet_rounds;
CREATE POLICY "public_read_rounds" ON bet_rounds
  FOR SELECT USING (true);

-- Markets: public read, service role write
DROP POLICY IF EXISTS "public_read_markets" ON markets;
CREATE POLICY "public_read_markets" ON markets
  FOR SELECT USING (true);

-- Bets: users see only their own
DROP POLICY IF EXISTS "own_bets_select" ON bets;
DROP POLICY IF EXISTS "own_bets_insert" ON bets;
CREATE POLICY "own_bets_select" ON bets
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own_bets_insert" ON bets
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Count snapshots: public read, service role write
DROP POLICY IF EXISTS "public_read_snapshots" ON count_snapshots;
CREATE POLICY "public_read_snapshots" ON count_snapshots
  FOR SELECT USING (true);

-- Messages: public read + guest/auth inserts.
DROP POLICY IF EXISTS "public_read_messages" ON messages;
CREATE POLICY "public_read_messages" ON messages
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "public_insert_messages" ON messages;
CREATE POLICY "public_insert_messages" ON messages
  FOR INSERT WITH CHECK (
    length(trim(username)) BETWEEN 1 AND 32
    AND length(trim(content)) BETWEEN 1 AND 280
    AND (
      user_id IS NULL
      OR auth.uid() = user_id
    )
  );

-- Site views: public write (telemetry), admin read.
DROP POLICY IF EXISTS "public_insert_site_views" ON site_views;
CREATE POLICY "public_insert_site_views" ON site_views
  FOR INSERT WITH CHECK (
    length(trim(page_path)) BETWEEN 1 AND 200
    AND (
      user_id IS NULL
      OR auth.uid() = user_id
    )
  );

DROP POLICY IF EXISTS "admin_read_site_views" ON site_views;
CREATE POLICY "admin_read_site_views" ON site_views
  FOR SELECT USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

-- Round sessions: public read (for next round timer), admin writes
DROP POLICY IF EXISTS "public_read_round_sessions" ON round_sessions;
DROP POLICY IF EXISTS "admin_write_round_sessions" ON round_sessions;
CREATE POLICY "public_read_round_sessions" ON round_sessions
  FOR SELECT USING (true);
CREATE POLICY "admin_write_round_sessions" ON round_sessions
  FOR ALL USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

-- ML pipeline tables: admin read/write (service role bypasses RLS for backend jobs)
DROP POLICY IF EXISTS "admin_rw_ml_detection_events" ON ml_detection_events;
CREATE POLICY "admin_rw_ml_detection_events" ON ml_detection_events
  FOR ALL USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  )
  WITH CHECK (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

DROP POLICY IF EXISTS "admin_rw_ml_training_jobs" ON ml_training_jobs;
CREATE POLICY "admin_rw_ml_training_jobs" ON ml_training_jobs
  FOR ALL USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  )
  WITH CHECK (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

DROP POLICY IF EXISTS "admin_rw_ml_model_registry" ON ml_model_registry;
CREATE POLICY "admin_rw_ml_model_registry" ON ml_model_registry
  FOR ALL USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  )
  WITH CHECK (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

-- ── Database functions ────────────────────────────────────────────────────────

-- Atomically place a bet: check balance → deduct → insert bet → update staked.
-- Called by bet_service.py via sb.rpc("place_bet_atomic", {...}).
-- SECURITY DEFINER runs as table owner, bypassing RLS for internal writes.
CREATE OR REPLACE FUNCTION place_bet_atomic(
  p_user_id        UUID,
  p_round_id       UUID,
  p_market_id      UUID,
  p_amount         INT,
  p_potential_payout INT
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_balance INT;
  v_bet_id  UUID;
BEGIN
  -- Auto-init balance for new users
  INSERT INTO user_balances (user_id, balance)
  VALUES (p_user_id, 1000)
  ON CONFLICT (user_id) DO NOTHING;

  -- Lock the row to prevent race conditions
  SELECT balance INTO v_balance
  FROM user_balances
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_balance < p_amount THEN
    RETURN json_build_object('error', 'Insufficient balance');
  END IF;

  -- Deduct stake
  UPDATE user_balances
  SET balance = balance - p_amount
  WHERE user_id = p_user_id;

  -- Insert bet
  INSERT INTO bets (user_id, round_id, market_id, amount, potential_payout, status)
  VALUES (p_user_id, p_round_id, p_market_id, p_amount, p_potential_payout, 'pending')
  RETURNING id INTO v_bet_id;

  -- Update market total_staked
  UPDATE markets
  SET total_staked = total_staked + p_amount
  WHERE id = p_market_id;

  RETURN json_build_object('bet_id', v_bet_id);
END;
$$;

-- Return a user's current balance. Auto-initialises to 1000 for new users.
CREATE OR REPLACE FUNCTION get_user_balance(p_user_id UUID)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO user_balances (user_id, balance)
  VALUES (p_user_id, 1000)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN (SELECT balance FROM user_balances WHERE user_id = p_user_id);
END;
$$;

-- Add credits to a user's balance (called on bet resolution/payout).
CREATE OR REPLACE FUNCTION credit_user_balance(p_user_id UUID, p_amount INT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO user_balances (user_id, balance)
  VALUES (p_user_id, p_amount)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = user_balances.balance + EXCLUDED.balance;
END;
$$;

-- Profile table for avatars + display names (public read for chat, user-owned writes)
CREATE TABLE IF NOT EXISTS profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  username TEXT NOT NULL CHECK (length(username) BETWEEN 1 AND 32),
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS public_read_profiles ON profiles;
CREATE POLICY public_read_profiles ON profiles
  FOR SELECT USING (true);

DROP POLICY IF EXISTS own_write_profiles ON profiles;
CREATE POLICY own_write_profiles ON profiles
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS own_update_profiles ON profiles;
CREATE POLICY own_update_profiles ON profiles
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_profiles_username ON profiles(username);

-- Optional storage bucket + policies for avatar uploads (run in Supabase SQL Editor)
INSERT INTO storage.buckets (id, name, public)
SELECT 'avatars', 'avatars', true
WHERE NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'avatars');

DROP POLICY IF EXISTS public_read_avatars ON storage.objects;
CREATE POLICY public_read_avatars ON storage.objects
  FOR SELECT
  USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS own_insert_avatars ON storage.objects;
CREATE POLICY own_insert_avatars ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'avatars'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS own_update_avatars ON storage.objects;
CREATE POLICY own_update_avatars ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'avatars'
    AND auth.uid()::text = (storage.foldername(name))[1]
  )
  WITH CHECK (
    bucket_id = 'avatars'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS own_delete_avatars ON storage.objects;
CREATE POLICY own_delete_avatars ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'avatars'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- ── ML dataset bucket (YOLO training data for Modal) ─────────────────────────
-- Public read is required so Modal can download data.yaml/images/labels by URL.
-- Writes are restricted to admins.
INSERT INTO storage.buckets (id, name, public)
SELECT 'ml-datasets', 'ml-datasets', true
WHERE NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'ml-datasets');

DROP POLICY IF EXISTS public_read_ml_datasets ON storage.objects;
CREATE POLICY public_read_ml_datasets ON storage.objects
  FOR SELECT
  USING (bucket_id = 'ml-datasets');

DROP POLICY IF EXISTS admin_insert_ml_datasets ON storage.objects;
CREATE POLICY admin_insert_ml_datasets ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'ml-datasets'
    AND (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

DROP POLICY IF EXISTS admin_update_ml_datasets ON storage.objects;
CREATE POLICY admin_update_ml_datasets ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'ml-datasets'
    AND (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  )
  WITH CHECK (
    bucket_id = 'ml-datasets'
    AND (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

DROP POLICY IF EXISTS admin_delete_ml_datasets ON storage.objects;
CREATE POLICY admin_delete_ml_datasets ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'ml-datasets'
    AND (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );
