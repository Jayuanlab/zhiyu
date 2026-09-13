-- A queued run has not started; preserve historical timestamps on existing runs.
ALTER TABLE workshop_runs ALTER COLUMN started_at DROP NOT NULL;
CREATE INDEX workshop_runs_queue_idx ON workshop_runs(created_at, id) WHERE status='queued';
