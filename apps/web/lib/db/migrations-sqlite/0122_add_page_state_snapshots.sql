CREATE TABLE IF NOT EXISTS "page_state_snapshots" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "User"("id") ON DELETE cascade,
  "key" text NOT NULL,
  "value" text NOT NULL,
  "meta" text NOT NULL,
  "generated_at" integer NOT NULL,
  "expires_at" integer NOT NULL,
  "stale_until" integer NOT NULL,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "page_state_snapshots_user_key_idx"
  ON "page_state_snapshots" ("user_id", "key");

CREATE INDEX IF NOT EXISTS "page_state_snapshots_user_expiry_idx"
  ON "page_state_snapshots" ("user_id", "expires_at");

CREATE INDEX IF NOT EXISTS "page_state_snapshots_stale_until_idx"
  ON "page_state_snapshots" ("stale_until");
