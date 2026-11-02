CREATE TABLE personal_daily_accounts (
 owner_id uuid PRIMARY KEY REFERENCES "User"(id) ON DELETE CASCADE,
 revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
 encrypted_data text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE personal_daily_days (
 owner_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
 business_date text NOT NULL CHECK (business_date ~ '^\d{4}-\d{2}-\d{2}$'),
 encrypted_data text NOT NULL,
 PRIMARY KEY (owner_id, business_date)
);
--> statement-breakpoint
CREATE TABLE personal_daily_sources (
 owner_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
 id uuid NOT NULL,
 encrypted_data text NOT NULL,
 PRIMARY KEY (owner_id,id)
);
--> statement-breakpoint
CREATE TABLE personal_daily_events (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
 command_id uuid NOT NULL,
 kind text NOT NULL,
 encrypted_data text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX personal_daily_events_owner_time ON personal_daily_events(owner_id,created_at);
--> statement-breakpoint
CREATE TABLE personal_daily_commands (
 owner_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
 id uuid NOT NULL,
 request_hash text NOT NULL,
 state text NOT NULL CHECK (state IN ('pending','completed','failed')),
 encrypted_result text,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (owner_id,id)
);
