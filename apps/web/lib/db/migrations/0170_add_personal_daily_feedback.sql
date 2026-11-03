CREATE TABLE personal_daily_feedback (
 owner_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
 id uuid NOT NULL, business_date text NOT NULL,
 work_id uuid NOT NULL, run_id uuid,
 status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','queued','processed','needs_input','failed')),
 encrypted_input text NOT NULL, encrypted_result text, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,id)
);
--> statement-breakpoint
CREATE INDEX personal_daily_feedback_owner_date ON personal_daily_feedback(owner_id,business_date,created_at);
