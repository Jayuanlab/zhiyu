CREATE TABLE memory_query_read_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('discover', 'recall')),
  request_hash text NOT NULL,
  refs jsonb NOT NULL,
  context_log_id uuid,
  coverage jsonb NOT NULL,
  trace_id uuid NOT NULL,
  contract_version text NOT NULL,
  implementation_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_query_read_receipts_owner_created_idx ON memory_query_read_receipts(user_id, created_at);
