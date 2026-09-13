CREATE TABLE interaction_legacy_reconciliations (
  owner_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  command_id uuid NOT NULL,
  manifest_hash text NOT NULL,
  manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
  confirmed_old_processes_stopped boolean NOT NULL CHECK(confirmed_old_processes_stopped),
  reconciled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,command_id)
);
