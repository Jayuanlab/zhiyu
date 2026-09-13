CREATE TABLE workshop_output_steps (
  run_id uuid NOT NULL REFERENCES workshop_run_outputs(run_id) ON DELETE CASCADE,
  step_kind text NOT NULL,
  step_index integer NOT NULL CHECK (step_index >= 0),
  result_json jsonb NOT NULL,
  worker_id text NOT NULL,
  fencing_token integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, step_kind, step_index)
);
