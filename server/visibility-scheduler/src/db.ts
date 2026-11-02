import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export type DB = DatabaseSync;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS channels (
  channel_id    TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  connected_at  INTEGER NOT NULL,
  -- 'ok', or 'reconnect' once Google refuses the refresh token
  state         TEXT NOT NULL CHECK (state IN ('ok', 'reconnect')),
  last_error    TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS device_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS oauth_states (
  state       TEXT PRIMARY KEY,
  purpose     TEXT NOT NULL CHECK (purpose IN ('login', 'connect')),
  verifier    TEXT NOT NULL,
  browser     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL,
  video_id        TEXT NOT NULL,
  video_title     TEXT NOT NULL,
  target          TEXT NOT NULL CHECK (target IN ('public', 'unlisted', 'private')),
  run_at          INTEGER NOT NULL,
  note            TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  created_by      TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed', 'cancelled')),
  next_attempt_at INTEGER,
  attempts        TEXT NOT NULL DEFAULT '[]',
  result          TEXT,
  updated_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS jobs_due ON jobs (state, run_at);
CREATE INDEX IF NOT EXISTS jobs_video ON jobs (video_id);
`;

export function openDb(dataDir: string): DB {
  const db = new DatabaseSync(join(dataDir, 'scheduler.sqlite'));
  db.exec(SCHEMA);
  return db;
}
