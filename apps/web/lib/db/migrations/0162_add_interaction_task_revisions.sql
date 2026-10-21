-- Stop incompatible legacy writers during the cutover. Their old UPDATE cannot
-- silently leave a stale concurrency token after this migration commits.
LOCK TABLE interaction_tasks IN ACCESS EXCLUSIVE MODE;
ALTER TABLE interaction_tasks ADD COLUMN revision bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM interaction_tasks WHERE jsonb_typeof(metadata) IS DISTINCT FROM 'object'
    OR metadata ? 'taskState' AND jsonb_typeof(metadata->'taskState') NOT IN ('object', 'null')) THEN
    RAISE EXCEPTION 'Invalid legacy interaction task metadata; repair explicitly before migration';
  END IF;
  IF EXISTS (SELECT 1 FROM interaction_tasks
    WHERE metadata->'taskState'->'version' IS NOT NULL
      AND NOT CASE WHEN jsonb_typeof(metadata->'taskState'->'version') = 'number' THEN
        (metadata->'taskState'->>'version')::numeric BETWEEN 0 AND 9007199254740990
        AND trunc((metadata->'taskState'->>'version')::numeric) = (metadata->'taskState'->>'version')::numeric ELSE false END) THEN
    RAISE EXCEPTION 'Invalid legacy interaction task version; repair explicitly before migration';
  END IF;
END $$;
UPDATE interaction_tasks SET revision = coalesce((metadata->'taskState'->>'version')::numeric, 0)::bigint;
UPDATE interaction_tasks SET metadata = jsonb_set(metadata, '{taskState}',
  coalesce(nullif(metadata->'taskState', 'null'::jsonb), '{}'::jsonb) || jsonb_build_object('version', revision));
ALTER TABLE interaction_tasks ADD CONSTRAINT interaction_tasks_revision_range CHECK (revision BETWEEN 0 AND 9007199254740991);
--> statement-breakpoint
CREATE TABLE interaction_task_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES interaction_tasks(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  command_id text NOT NULL,
  request_hash text NOT NULL,
  action text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX interaction_task_revisions_version_unique ON interaction_task_revisions(user_id, task_id, revision);
CREATE UNIQUE INDEX interaction_task_revisions_command_unique ON interaction_task_revisions(user_id, command_id);
INSERT INTO interaction_task_revisions(user_id, task_id, revision, command_id, request_hash, action, snapshot)
  SELECT user_id, id, revision, 'baseline:' || id::text, 'legacy_baseline_not_a_replayable_command', 'legacy_baseline',
    jsonb_build_object('historyCoverage', 'from_migration_only', 'task', to_jsonb(interaction_tasks)) FROM interaction_tasks;
--> statement-breakpoint
CREATE FUNCTION guard_interaction_task_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revision <> OLD.revision + 1 OR
    NEW.metadata->'taskState'->>'version' IS DISTINCT FROM NEW.revision::text THEN
    RAISE EXCEPTION 'Interaction task writes require the versioned command path' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER interaction_tasks_version_guard BEFORE UPDATE ON interaction_tasks
  FOR EACH ROW WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD.description IS DISTINCT FROM NEW.description
    OR OLD.status IS DISTINCT FROM NEW.status OR OLD.due_at IS DISTINCT FROM NEW.due_at
    OR OLD.assignee_name IS DISTINCT FROM NEW.assignee_name OR OLD.requester_name IS DISTINCT FROM NEW.requester_name
    OR OLD.source_event_ids IS DISTINCT FROM NEW.source_event_ids OR OLD.confidence IS DISTINCT FROM NEW.confidence
    OR OLD.metadata IS DISTINCT FROM NEW.metadata OR OLD.updated_at IS DISTINCT FROM NEW.updated_at
    OR OLD.revision IS DISTINCT FROM NEW.revision)
  EXECUTE FUNCTION guard_interaction_task_revision();
--> statement-breakpoint
CREATE FUNCTION guard_interaction_task_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revision <> 0 OR NEW.metadata->'taskState'->>'version' IS DISTINCT FROM '0' THEN
    RAISE EXCEPTION 'Interaction task creation requires the versioned command path' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER interaction_tasks_insert_guard BEFORE INSERT ON interaction_tasks
  FOR EACH ROW EXECUTE FUNCTION guard_interaction_task_insert();
CREATE FUNCTION require_interaction_task_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Owner/raw-source cascades may remove the task in this transaction. An
  -- extant task must retain every command revision committed for it.
  IF EXISTS (SELECT 1 FROM interaction_tasks WHERE id = NEW.id AND user_id = NEW.user_id)
    AND NOT EXISTS (SELECT 1 FROM interaction_task_revisions
      WHERE user_id = NEW.user_id AND task_id = NEW.id AND revision = NEW.revision) THEN
    RAISE EXCEPTION 'Interaction task revision audit is required before commit' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER interaction_tasks_audit_guard AFTER INSERT OR UPDATE ON interaction_tasks
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_interaction_task_audit();
--> statement-breakpoint
CREATE TABLE memory_state_read_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  target jsonb NOT NULL,
  revision text NOT NULL,
  locator jsonb NOT NULL,
  trace_id uuid NOT NULL,
  contract_version text NOT NULL,
  implementation_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_state_read_receipts_user_idx ON memory_state_read_receipts(user_id, created_at);
