CREATE TABLE workshop_outbox_recovery (
 attempt_id uuid PRIMARY KEY REFERENCES workshop_outbox_attempts(id) ON DELETE RESTRICT,
 last_checked_at timestamptz,
 next_check_at timestamptz DEFAULT clock_timestamp(),
 lease_until timestamptz,
 token uuid,
 worker_id text,
 failures integer NOT NULL DEFAULT 0 CHECK (failures>=0),
 detail text
);
CREATE INDEX workshop_outbox_recovery_due ON workshop_outbox_recovery(next_check_at);
