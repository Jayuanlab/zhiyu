CREATE TABLE workshop_run_plans (
  run_id uuid PRIMARY KEY REFERENCES workshop_runs(id) ON DELETE CASCADE,
  workshop_id uuid NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
  checkpoint_json jsonb NOT NULL,
  worker_id text NOT NULL,
  fencing_token integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
ALTER TABLE workshop_output_steps DROP CONSTRAINT workshop_output_steps_run_id_fkey;
--> statement-breakpoint
ALTER TABLE workshop_output_steps ADD CONSTRAINT workshop_output_steps_run_id_fkey FOREIGN KEY(run_id) REFERENCES workshop_runs(id) ON DELETE CASCADE;
