CREATE TABLE IF NOT EXISTS movie_cache (
    cache_key TEXT PRIMARY KEY,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS movie_cache_updated ON movie_cache(updated_at DESC);

CREATE TABLE IF NOT EXISTS media_cache (
 cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)),
 updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS media_cache_updated ON media_cache(updated_at DESC);
CREATE TABLE IF NOT EXISTS parser_config (
 config_key TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)), updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS diagnostics_logs (
 id TEXT PRIMARY KEY, code TEXT NOT NULL, created_at INTEGER NOT NULL,
 version TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE INDEX IF NOT EXISTS diagnostics_created ON diagnostics_logs(created_at DESC);
CREATE TABLE IF NOT EXISTS maintenance_runs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, ok INTEGER NOT NULL, payload TEXT NOT NULL
);
-- A single current APK plus a bounded staging upload, within the existing free D1 database.
CREATE TABLE IF NOT EXISTS apk_releases (
 id TEXT PRIMARY KEY, version_code INTEGER NOT NULL, metadata TEXT NOT NULL CHECK(json_valid(metadata)),
 created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS apk_chunks (
 release_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, data BLOB NOT NULL,
 PRIMARY KEY(release_id, chunk_index)
);
