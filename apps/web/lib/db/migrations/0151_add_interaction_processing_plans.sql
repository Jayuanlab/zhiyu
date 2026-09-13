CREATE TABLE interaction_processing_plans (
  job_id uuid PRIMARY KEY REFERENCES interaction_processing_jobs(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  execution_attempt integer NOT NULL CHECK(execution_attempt>0),
  atomic_write_version integer NOT NULL CHECK(atomic_write_version=1),
  plan_hash text NOT NULL,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
ALTER TABLE interaction_review_decisions DROP CONSTRAINT interaction_review_decisions_decision_check;
--> statement-breakpoint
ALTER TABLE interaction_review_decisions ADD CONSTRAINT interaction_review_decisions_decision_check CHECK(decision IN ('keep_results_end','resume_plan'));
--> statement-breakpoint
ALTER TABLE interaction_review_decisions ADD COLUMN plan_hash text;
