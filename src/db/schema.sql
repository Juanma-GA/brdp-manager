CREATE TABLE IF NOT EXISTS brdps (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  title TEXT,
  definition TEXT,
  proposal TEXT,
  validation TEXT DEFAULT 'Pending',
  comments TEXT,
  history TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  brdp_id TEXT PRIMARY KEY,
  text TEXT NOT NULL DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);
