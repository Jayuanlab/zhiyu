-- Repair confirmed omissions from unregistered 0074/0075/0076/0087/0093.
ALTER TABLE "rss_subscriptions" ADD COLUMN IF NOT EXISTS "last_error_code" varchar(32);
ALTER TABLE "rss_subscriptions" ADD COLUMN IF NOT EXISTS "last_error_message" text;
ALTER TABLE "characters" ADD COLUMN IF NOT EXISTS "system_notification" boolean NOT NULL DEFAULT true;
ALTER TABLE "rag_chunks" ALTER COLUMN "embedding" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "feedback" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "contact_email" text;
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "type" text NOT NULL DEFAULT 'general';
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "title" text NOT NULL DEFAULT '';
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "description" text NOT NULL DEFAULT '';
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'open';
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "priority" text DEFAULT 'medium';
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'web';
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "system_info" json;
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "updated_at" timestamp;
-- A legacy row has no observed edit time. Preserve creation time as its baseline.
UPDATE "feedback" SET "updated_at"="created_at" WHERE "updated_at" IS NULL;
ALTER TABLE "feedback" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "feedback" ALTER COLUMN "updated_at" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "feedback_status_idx" ON "feedback" ("status");
CREATE INDEX IF NOT EXISTS "feedback_source_idx" ON "feedback" ("source");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "insight_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "insight_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "content" text NOT NULL,
  "source" varchar(32) NOT NULL DEFAULT 'manual',
  "source_message_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "insight_notes_insight_idx" ON "insight_notes" ("insight_id");
CREATE INDEX IF NOT EXISTS "insight_notes_user_idx" ON "insight_notes" ("user_id");
CREATE INDEX IF NOT EXISTS "insight_notes_created_at_idx" ON "insight_notes" ("created_at");
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "insight_notes" ADD CONSTRAINT "insight_notes_insight_id_fkey" FOREIGN KEY ("insight_id") REFERENCES "Insight"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "insight_notes" ADD CONSTRAINT "insight_notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "insight_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "insight_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "insight_documents_insight_idx" ON "insight_documents" ("insight_id");
CREATE INDEX IF NOT EXISTS "insight_documents_document_idx" ON "insight_documents" ("document_id");
CREATE INDEX IF NOT EXISTS "insight_documents_user_idx" ON "insight_documents" ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "unique_insight_document" ON "insight_documents" ("insight_id","document_id");
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "insight_documents" ADD CONSTRAINT "insight_documents_insight_id_fkey" FOREIGN KEY ("insight_id") REFERENCES "Insight"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "insight_documents" ADD CONSTRAINT "insight_documents_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "rag_documents"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "insight_documents" ADD CONSTRAINT "insight_documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
