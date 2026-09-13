CREATE TABLE workshop_run_outputs (
  run_id uuid PRIMARY KEY REFERENCES workshop_runs(id) ON DELETE CASCADE,
  workshop_id uuid NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
  result_json jsonb NOT NULL,
  directive_ids jsonb NOT NULL,
  worker_id text NOT NULL,
  fencing_token integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
