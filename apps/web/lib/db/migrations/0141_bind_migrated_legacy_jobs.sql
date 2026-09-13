ALTER TABLE loop_runtime_migrations ADD COLUMN legacy_job_id uuid REFERENCES scheduled_jobs(id) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX loop_runtime_migrations_legacy_job_idx ON loop_runtime_migrations(legacy_job_id) WHERE legacy_job_id IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION guard_migrated_legacy_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM loop_runtime_migrations WHERE legacy_job_id=NEW.id) THEN
    RAISE EXCEPTION 'Migrated job is retired; use its Work' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER migrated_legacy_job_guard BEFORE UPDATE ON scheduled_jobs FOR EACH ROW EXECUTE FUNCTION guard_migrated_legacy_job();
--> statement-breakpoint
CREATE FUNCTION guard_migrated_legacy_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM scheduled_jobs WHERE id=NEW.job_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM loop_runtime_migrations WHERE legacy_job_id=NEW.job_id) THEN
    RAISE EXCEPTION 'Migrated job cannot accept legacy executions' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER migrated_legacy_execution_guard BEFORE INSERT OR UPDATE ON job_executions FOR EACH ROW EXECUTE FUNCTION guard_migrated_legacy_execution();
