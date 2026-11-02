CREATE TABLE IF NOT EXISTS user_model_center_versions (
  user_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  document jsonb NOT NULL,
  secrets_encrypted text NOT NULL,
  action text NOT NULL CHECK (action IN ('save','rollback','compatibility')),
  restored_from integer,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, revision)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS user_model_center_heads (
  user_id uuid PRIMARY KEY REFERENCES "User"(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (user_id,revision) REFERENCES user_model_center_versions(user_id,revision)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS user_model_connection_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  connection_id text NOT NULL,
  revision integer NOT NULL,
  model text NOT NULL,
  capability text NOT NULL,
  passed boolean NOT NULL,
  detail text NOT NULL,
  duration_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_model_tests_owner_time_idx ON user_model_connection_tests(user_id,created_at DESC);

