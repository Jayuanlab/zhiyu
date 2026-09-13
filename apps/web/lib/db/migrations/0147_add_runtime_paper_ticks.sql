CREATE TABLE runtime_paper_ticks (
  owner_id uuid NOT NULL REFERENCES "User"(id),
  account_id uuid NOT NULL,
  sequence integer NOT NULL DEFAULT 0 CHECK (sequence>=0),
  command_id text,
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','pending','completed')),
  next_tick_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  receipt jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,account_id),
  CHECK (status='idle' OR command_id IS NOT NULL)
);
