CREATE TABLE workshop_outbox_attempts (
 id uuid PRIMARY KEY,
 outbox_id uuid NOT NULL REFERENCES workshop_outbox(id) ON DELETE RESTRICT,
 workshop_id uuid NOT NULL REFERENCES workshops(id) ON DELETE RESTRICT,
 owner_id uuid NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
 command_id text NOT NULL,
 content_hash text NOT NULL,
 policy_hash text NOT NULL,
 payload jsonb NOT NULL,
 status text NOT NULL CHECK (status IN ('sending','sent','unknown','failed')),
 provider_receipt jsonb,
 failure_phase text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_id,command_id)
);
CREATE UNIQUE INDEX workshop_outbox_active_attempt ON workshop_outbox_attempts(outbox_id) WHERE status IN ('sending','sent','unknown');
