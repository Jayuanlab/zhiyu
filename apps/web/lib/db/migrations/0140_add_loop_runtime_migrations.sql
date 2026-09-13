CREATE TABLE loop_runtime_migrations (
  loop_id uuid PRIMARY KEY REFERENCES loops(id) ON DELETE RESTRICT,
  workshop_id uuid NOT NULL REFERENCES workshops(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
  command_id text NOT NULL,
  snapshot_hash text NOT NULL,
  source_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(owner_id, command_id)
);
--> statement-breakpoint
CREATE FUNCTION guard_migrated_loop_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM loops WHERE id=NEW.loop_id FOR UPDATE;
  IF NEW.status <> 'queued' AND EXISTS(SELECT 1 FROM loop_runtime_migrations WHERE loop_id=NEW.loop_id) THEN
    RAISE EXCEPTION 'Migrated Loop requires Work queue admission' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER loop_run_migration_guard BEFORE INSERT ON loop_runs FOR EACH ROW EXECUTE FUNCTION guard_migrated_loop_run();
