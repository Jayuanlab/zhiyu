CREATE TABLE IF NOT EXISTS "page_state_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "User"("id") ON DELETE cascade,
  "key" text NOT NULL,
  "value" jsonb NOT NULL,
  "meta" jsonb NOT NULL,
  "generated_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "stale_until" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "page_state_snapshots_user_key_idx"
  ON "page_state_snapshots" ("user_id", "key");

CREATE INDEX IF NOT EXISTS "page_state_snapshots_user_expiry_idx"
  ON "page_state_snapshots" ("user_id", "expires_at");

CREATE INDEX IF NOT EXISTS "page_state_snapshots_stale_until_idx"
  ON "page_state_snapshots" ("stale_until");
