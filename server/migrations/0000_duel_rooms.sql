CREATE TABLE duel_rooms (
    id TEXT PRIMARY KEY NOT NULL,
    host_request TEXT NOT NULL UNIQUE,
    host_token TEXT NOT NULL,
    guest_token TEXT,
    level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 4),
    puzzle TEXT NOT NULL CHECK (length(puzzle) = 81),
    expires_at INTEGER NOT NULL,
    host_ready INTEGER NOT NULL DEFAULT 0,
    guest_ready INTEGER NOT NULL DEFAULT 0,
    start_at INTEGER,
    winner TEXT CHECK (winner IN ('host','guest')),
    finish_at INTEGER,
    closed INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX duel_rooms_expiry ON duel_rooms (expires_at);
