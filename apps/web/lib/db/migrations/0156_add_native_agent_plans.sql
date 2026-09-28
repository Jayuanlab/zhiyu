CREATE TABLE IF NOT EXISTS "native_agent_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL REFERENCES "User"("id") ON DELETE cascade,
  "plan_id" text NOT NULL,
  "plan_json" jsonb NOT NULL,
  "original_prompt" text NOT NULL,
  "work_dir" text,
  "task_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "native_agent_plans_owner_plan_idx"
  ON "native_agent_plans" ("owner_id", "plan_id");

CREATE INDEX IF NOT EXISTS "native_agent_plans_plan_id_idx"
  ON "native_agent_plans" ("plan_id");

CREATE INDEX IF NOT EXISTS "native_agent_plans_expires_idx"
  ON "native_agent_plans" ("expires_at");
