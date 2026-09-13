-- Only database-local handlers may use this ledger until external execution
-- leases and domain recovery are implemented. Legacy writers do not advance it.
CREATE TABLE work_command_targets (
  workshop_id uuid PRIMARY KEY REFERENCES workshops(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0)
);
--> statement-breakpoint
CREATE TABLE work_commands (
  owner_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  command_id varchar(256) NOT NULL,
  target_id uuid NOT NULL,
  type varchar(100) NOT NULL,
  payload_hash varchar(64) NOT NULL,
  payload jsonb NOT NULL,
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  status varchar(20) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'succeeded', 'failed')),
  result jsonb,
  error_code varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (owner_id, command_id),
  CHECK ((status = 'queued' AND completed_at IS NULL AND result IS NULL AND error_code IS NULL)
    OR (status = 'succeeded' AND completed_at IS NOT NULL AND result IS NOT NULL AND error_code IS NULL)
    OR (status = 'failed' AND completed_at IS NOT NULL AND result IS NULL AND error_code IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX work_commands_target_created_idx ON work_commands (owner_id, target_id, created_at);
