CREATE TABLE IF NOT EXISTS "workshop_runtime_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workshop_id" uuid NOT NULL REFERENCES "workshops"("id") ON DELETE cascade,
  "run_id" uuid NOT NULL REFERENCES "workshop_runs"("id") ON DELETE cascade,
  "event_id" uuid REFERENCES "workshop_events"("id") ON DELETE set null,
  "loop_id" uuid REFERENCES "loops"("id") ON DELETE set null,
  "loop_run_id" uuid REFERENCES "loop_runs"("id") ON DELETE set null,
  "engine" varchar(20) NOT NULL,
  "adapter" text NOT NULL,
  "model" text NOT NULL,
  "model_tier" text NOT NULL,
  "runtime_hash" varchar(64) NOT NULL,
  "policy_hash" varchar(64) NOT NULL,
  "allowed_tool_count" integer NOT NULL,
  "snapshot_json" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "workshop_runtime_snapshots_event_idx"
  ON "workshop_runtime_snapshots" ("event_id")
  WHERE "event_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "workshop_runtime_snapshots_run_created_idx"
  ON "workshop_runtime_snapshots" ("run_id", "created_at");

CREATE INDEX IF NOT EXISTS "workshop_runtime_snapshots_workshop_run_idx"
  ON "workshop_runtime_snapshots" ("workshop_id", "run_id");

CREATE INDEX IF NOT EXISTS "workshop_runtime_snapshots_runtime_hash_idx"
  ON "workshop_runtime_snapshots" ("runtime_hash");
