CREATE TABLE memory_plan_records (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  plan_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  state text NOT NULL CHECK (state IN ('ready','approved','revoked')),
  origin text NOT NULL CHECK (origin IN ('generated','owner_rebased_legacy')),
  plan_json jsonb NOT NULL CHECK (jsonb_typeof(plan_json)='object'),
  prompt_snapshot text NOT NULL,
  input_observation_id uuid NOT NULL,
  source_receipt_ids jsonb NOT NULL CHECK (jsonb_typeof(source_receipt_ids)='array'),
  version text NOT NULL,
  parent_version text,
  legacy_version text,
  task_id uuid,
  work_dir text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,plan_id,revision)
);
CREATE INDEX memory_plan_records_owner_latest ON memory_plan_records(user_id,plan_id,revision DESC);
CREATE TABLE memory_plan_commands (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  command_id uuid NOT NULL,
  plan_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('generated','legacy_rebase','approve','revoke')),
  request_hash text NOT NULL,
  result_record_id uuid NOT NULL REFERENCES memory_plan_records(id) ON DELETE CASCADE,
  execution_state text CHECK (execution_state IN ('running','completed','failed','interrupted')),
  execution_started_at timestamptz,
  execution_finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,command_id)
);
