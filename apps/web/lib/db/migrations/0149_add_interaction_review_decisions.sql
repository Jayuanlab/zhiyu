CREATE TABLE interaction_review_decisions (
  owner_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  command_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES interaction_processing_jobs(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK(attempt>0),
  decision text NOT NULL CHECK(decision='keep_results_end'),
  acknowledged_unknown boolean NOT NULL CHECK(acknowledged_unknown),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,command_id),
  UNIQUE(job_id,attempt)
);
