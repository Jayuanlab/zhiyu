CREATE TABLE workshop_outbox_resolutions (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
 workshop_id uuid NOT NULL REFERENCES workshops(id) ON DELETE RESTRICT,
 attempt_id uuid NOT NULL REFERENCES workshop_outbox_attempts(id) ON DELETE RESTRICT,
 command_id text NOT NULL,
 payload_hash text NOT NULL,
 request_json jsonb NOT NULL,
 status text NOT NULL CHECK (status IN ('pending','completed')),
 result_json jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz,
 UNIQUE(owner_id,command_id)
);
CREATE UNIQUE INDEX workshop_outbox_pending_resolution ON workshop_outbox_resolutions(attempt_id) WHERE status='pending';
