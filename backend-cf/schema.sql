CREATE TABLE IF NOT EXISTS movie_cache (
    cache_key TEXT PRIMARY KEY,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS movie_cache_updated ON movie_cache(updated_at DESC);
