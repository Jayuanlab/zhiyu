CREATE TABLE legacy_execution_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL REFERENCES job_executions(id) ON DELETE CASCADE,
  loop_id uuid NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  command_id text NOT NULL,
  payload_hash text NOT NULL,
  snapshot_hash text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('no_effect','effects_verified')),
  evidence text NOT NULL CHECK (length(btrim(evidence)) BETWEEN 1 AND 8000),
  controllers_stopped boolean NOT NULL CHECK (controllers_stopped),
  source text NOT NULL CHECK (source='owner'),
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(owner_id,command_id),
  UNIQUE(execution_id,snapshot_hash)
);
