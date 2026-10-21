CREATE TABLE IF NOT EXISTS memory_operation_receipts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  command_id text NOT NULL,
  request_hash text NOT NULL,
  observation_id uuid NOT NULL,
  revision text NOT NULL,
  trace_id uuid NOT NULL,
  contract_version text NOT NULL,
  implementation_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS memory_operation_receipts_owner_command_idx ON memory_operation_receipts(user_id,command_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS memory_read_receipts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('current','evidence')),
  observation_id uuid NOT NULL,
  revision text NOT NULL,
  actual_range jsonb NOT NULL,
  total_length integer NOT NULL,
  trace_id uuid NOT NULL,
  contract_version text NOT NULL,
  implementation_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS memory_read_receipts_owner_created_idx ON memory_read_receipts(user_id,created_at);
