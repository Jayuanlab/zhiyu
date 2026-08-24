CREATE TABLE IF NOT EXISTS "workshop_review_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workshop_id" uuid NOT NULL REFERENCES "workshops"("id") ON DELETE cascade,
  "source_event_id" uuid REFERENCES "workshop_events"("id") ON DELETE set null,
  "kind" varchar(60) NOT NULL,
  "status" varchar(30) DEFAULT 'pending' NOT NULL,
  "title" text NOT NULL,
  "summary" text,
  "risk_level" varchar(20),
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "workshop_review_items_workshop_status_idx"
  ON "workshop_review_items" ("workshop_id", "status", "created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "workshop_review_items_source_event_idx"
  ON "workshop_review_items" ("source_event_id");
