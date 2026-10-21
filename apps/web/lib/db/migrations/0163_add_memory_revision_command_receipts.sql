CREATE TABLE memory_revision_command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  command_id text NOT NULL,
  request_hash text NOT NULL,
  kind text NOT NULL,
  outcome jsonb NOT NULL,
  trace_id uuid NOT NULL,
  contract_version text NOT NULL,
  implementation_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX memory_revision_command_receipts_command_unique ON memory_revision_command_receipts(user_id, command_id);
