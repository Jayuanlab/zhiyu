CREATE TABLE IF NOT EXISTS "workshop_review_items" (
  "id" text PRIMARY KEY NOT NULL,
  "workshop_id" text NOT NULL REFERENCES "workshops"("id") ON DELETE cascade,
  "source_event_id" text REFERENCES "workshop_events"("id") ON DELETE set null,
  "kind" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "title" text NOT NULL,
  "summary" text,
  "risk_level" text,
  "metadata" text DEFAULT '{}' NOT NULL,
  "created_at" integer DEFAULT (unixepoch() * 1000) NOT NULL,
  "updated_at" integer DEFAULT (unixepoch() * 1000) NOT NULL,
  "resolved_at" integer
);

CREATE INDEX IF NOT EXISTS "workshop_review_items_workshop_status_idx"
  ON "workshop_review_items" ("workshop_id", "status", "created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "workshop_review_items_source_event_idx"
  ON "workshop_review_items" ("source_event_id");
