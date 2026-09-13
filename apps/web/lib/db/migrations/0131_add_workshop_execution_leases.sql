CREATE TABLE workshop_execution_leases (
  workshop_id uuid PRIMARY KEY REFERENCES workshops(id) ON DELETE CASCADE,
  token integer NOT NULL DEFAULT 0 CHECK (token >= 0),
  run_id uuid,
  worker_id text,
  phase text NOT NULL DEFAULT 'idle' CHECK (phase IN ('idle','running','needs_review')),
  lease_until timestamptz,
  heartbeat_at timestamptz,
  effect_started boolean NOT NULL DEFAULT false,
  result_json jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workshop_execution_leases_active_check CHECK (phase = 'idle' OR (run_id IS NOT NULL AND worker_id IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX workshop_execution_leases_expiry_idx ON workshop_execution_leases(lease_until) WHERE phase='running';
