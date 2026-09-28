CREATE TABLE IF NOT EXISTS work_collaboration_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  requester_work_id uuid NOT NULL,
  recipient_work_id uuid NOT NULL,
  requester_name text NOT NULL,
  recipient_name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('notice', 'consult', 'delegate')),
  needed_capability text,
  status text NOT NULL CHECK (status IN ('delivered', 'accepted', 'needs_info', 'declined', 'replied', 'verified', 'cancelled')),
  problem text NOT NULL,
  desired_outcome text NOT NULL,
  why_help_needed text NOT NULL,
  acceptance_criteria text,
  source_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  origin_run_id uuid,
  origin_loop_id uuid,
  recipient_run_id uuid,
  response text,
  resolution_note text,
  idempotency_key text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT work_collaboration_distinct_works CHECK (requester_work_id <> recipient_work_id),
  CONSTRAINT work_collaboration_problem_length CHECK (length(problem) BETWEEN 1 AND 4000),
  CONSTRAINT work_collaboration_outcome_length CHECK (length(desired_outcome) BETWEEN 1 AND 2000),
  CONSTRAINT work_collaboration_reason_length CHECK (length(why_help_needed) BETWEEN 1 AND 2000),
  CONSTRAINT work_collaboration_idempotency UNIQUE (owner_id, requester_work_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS work_collaboration_inbox_idx
  ON work_collaboration_requests(owner_id, recipient_work_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS work_collaboration_outbox_idx
  ON work_collaboration_requests(owner_id, requester_work_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS work_collaboration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES work_collaboration_requests(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  actor_work_id uuid,
  actor_type text NOT NULL CHECK (actor_type IN ('owner', 'work', 'system')),
  action text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  detail text,
  command_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_collaboration_event_seq UNIQUE (request_id, seq),
  CONSTRAINT work_collaboration_event_command UNIQUE (request_id, command_id)
);
