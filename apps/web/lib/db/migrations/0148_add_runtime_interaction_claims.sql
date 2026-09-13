CREATE TABLE runtime_interaction_claims (
  job_id uuid NOT NULL REFERENCES interaction_processing_jobs(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0),
  owner_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  instance_id uuid NOT NULL REFERENCES runtime_instances(id),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recovered_at timestamptz,
  PRIMARY KEY(job_id, attempt)
);
CREATE INDEX runtime_interaction_claims_owner_idx ON runtime_interaction_claims(owner_id, instance_id);
