-- 0077 exists on disk but was never registered in the migration journal.
-- Append a repair so already-upgraded databases also receive the table.
CREATE TABLE IF NOT EXISTS "insight_brief_categories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "insight_id" uuid NOT NULL,
  "category" varchar(20) NOT NULL,
  "dedupe_key" text,
  "title" text,
  "assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
  "source" varchar(20) DEFAULT 'manual' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "insight_brief_categories_user_insight_idx" ON "insight_brief_categories" ("user_id", "insight_id");
CREATE INDEX IF NOT EXISTS "insight_brief_categories_user_idx" ON "insight_brief_categories" ("user_id");
CREATE INDEX IF NOT EXISTS "insight_brief_categories_dedupe_idx" ON "insight_brief_categories" ("dedupe_key");
CREATE INDEX IF NOT EXISTS "insight_brief_categories_category_idx" ON "insight_brief_categories" ("category");
CREATE INDEX IF NOT EXISTS "insight_brief_categories_assigned_at_idx" ON "insight_brief_categories" ("assigned_at");
--> statement-breakpoint
-- Separate blocks also repair a manually-created table with only one FK present.
DO $$ BEGIN
  ALTER TABLE "insight_brief_categories" ADD CONSTRAINT "insight_brief_categories_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "insight_brief_categories" ADD CONSTRAINT "insight_brief_categories_insight_id_fkey"
    FOREIGN KEY ("insight_id") REFERENCES "Insight"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "insight_brief_categories" ADD CONSTRAINT "insight_brief_categories_category_check"
    CHECK ("category" IN ('urgent', 'important', 'monitor', 'archive'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- Preserve existing rows; permit the explicit unpin state used by current APIs.
ALTER TABLE "insight_brief_categories" DROP CONSTRAINT IF EXISTS "insight_brief_categories_source_check";
ALTER TABLE "insight_brief_categories" ADD CONSTRAINT "insight_brief_categories_source_check"
  CHECK ("source" IN ('manual', 'auto', 'unpinned'));
