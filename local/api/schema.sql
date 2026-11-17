CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('chest', 'bag')),
  room_id TEXT NOT NULL DEFAULT '',
  creator TEXT NOT NULL,
  total_coins BIGINT NOT NULL DEFAULT 0,
  winner_count INTEGER NOT NULL DEFAULT 0,
  participant_count INTEGER,
  viewer_count INTEGER,
  ratio DOUBLE PRECISION,
  opens_at_ms BIGINT NOT NULL DEFAULT 0,
  expires_at_ms BIGINT NOT NULL DEFAULT 0,
  chest_type TEXT,
  chest_status TEXT CHECK (chest_status IS NULL OR chest_status IN ('active', 'hung')),
  bag_level INTEGER,
  bag_method INTEGER,
  bag_comment TEXT,
  country_code TEXT,
  rank_label TEXT,
  event_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_expiry_idx ON events (expires_at_ms);
CREATE INDEX IF NOT EXISTS events_kind_idx ON events (kind);
