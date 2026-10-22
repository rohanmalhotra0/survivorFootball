import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS leagues (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      invite_code TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL REFERENCES users(id),
      season INTEGER NOT NULL,
      start_week INTEGER NOT NULL CHECK (start_week BETWEEN 1 AND 18),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS members (
      league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (league_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS picks (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      week INTEGER NOT NULL CHECK (week BETWEEN 1 AND 18),
      team_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (league_id, user_id) REFERENCES members(league_id, user_id) ON DELETE CASCADE,
      UNIQUE (league_id, user_id, week),
      UNIQUE (league_id, user_id, team_id)
    );
    CREATE INDEX IF NOT EXISTS picks_league_week ON picks(league_id, week);
  `);
  return db;
}

export type Database = ReturnType<typeof openDatabase>;
