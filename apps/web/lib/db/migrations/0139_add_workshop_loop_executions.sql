CREATE TABLE workshop_loop_executions (
  run_id uuid PRIMARY KEY REFERENCES workshop_runs(id) ON DELETE RESTRICT,
  loop_run_id uuid NOT NULL UNIQUE REFERENCES loop_runs(id) ON DELETE RESTRICT,
  loop_id uuid NOT NULL REFERENCES loops(id) ON DELETE RESTRICT,
  workshop_id uuid NOT NULL REFERENCES workshops(id) ON DELETE RESTRICT,
  request_json jsonb NOT NULL,
  result_json jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
CREATE UNIQUE INDEX workshop_loop_executions_active_loop_idx ON workshop_loop_executions(loop_id) WHERE active;
--> statement-breakpoint
ALTER TABLE loop_runs ALTER COLUMN started_at DROP NOT NULL;
