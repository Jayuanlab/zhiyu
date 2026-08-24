ALTER TABLE "brain_memories"
  ADD COLUMN IF NOT EXISTS "canonical_kind" varchar(40);
--> statement-breakpoint
ALTER TABLE "brain_memories"
  ADD COLUMN IF NOT EXISTS "canonical_group_id" text;
--> statement-breakpoint
UPDATE "brain_memories"
SET
  "canonical_kind" = COALESCE("canonical_kind", "metadata"->>'canonicalKind'),
  "canonical_group_id" = COALESCE("canonical_group_id", "metadata"->>'canonicalGroupId')
WHERE "metadata" IS NOT NULL
  AND (
    "canonical_kind" IS NULL
    OR "canonical_group_id" IS NULL
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_memories_canonical_group_idx"
  ON "brain_memories" (
    "user_id",
    "owner_type",
    "owner_id",
    "scope_type",
    "scope_id",
    "canonical_group_id"
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_memories_canonical_kind_idx"
  ON "brain_memories" ("user_id", "canonical_kind", "status");
