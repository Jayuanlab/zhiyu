CREATE TABLE "memory_artifact_manifests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "command_id" varchar(200) NOT NULL, "request_hash" text NOT NULL,
  "revision" integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  "state" text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sealed','active','deleting','deleted')),
  "provider" text NOT NULL CHECK (provider IN ('private_local','private_blob')), "object_key" text NOT NULL,
  "name" text NOT NULL, "content_type" text NOT NULL, "size_bytes" bigint NOT NULL CHECK (size_bytes > 0),
  "sha256" text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  "expires_at" timestamptz NOT NULL, "quota_charged" boolean NOT NULL DEFAULT false,
  "cleanup_attempts" integer NOT NULL DEFAULT 0, "last_error" text,
  "user_file_id" uuid REFERENCES "user_files"("id") ON DELETE SET NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}', "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "memory_artifact_manifests_request_hash_check" CHECK (request_hash ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "memory_artifact_manifests_owner_command_idx" ON "memory_artifact_manifests"("user_id","command_id");
CREATE UNIQUE INDEX "memory_artifact_manifests_object_key_idx" ON "memory_artifact_manifests"("object_key");
CREATE INDEX "memory_artifact_manifests_owner_state_idx" ON "memory_artifact_manifests"("user_id","state");
CREATE INDEX "memory_artifact_manifests_recovery_idx" ON "memory_artifact_manifests"("state","expires_at");
--> statement-breakpoint
CREATE TABLE "memory_artifact_command_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "command_id" varchar(200) NOT NULL, "request_hash" text NOT NULL,
  "artifact_id" uuid NOT NULL REFERENCES "memory_artifact_manifests"("id") ON DELETE CASCADE,
  "action" text NOT NULL, "from_revision" integer NOT NULL, "to_revision" integer NOT NULL,
  "result" jsonb NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "memory_artifact_command_receipts_owner_command_idx" ON "memory_artifact_command_receipts"("user_id","command_id");
CREATE INDEX "memory_artifact_command_receipts_artifact_idx" ON "memory_artifact_command_receipts"("artifact_id","created_at");
--> statement-breakpoint
CREATE TABLE "memory_artifact_read_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "artifact_id" uuid NOT NULL REFERENCES "memory_artifact_manifests"("id") ON DELETE CASCADE,
  "purpose" text NOT NULL DEFAULT 'evidence' CHECK (purpose IN ('current','evidence')),
  "revision" text NOT NULL, "actual_range" jsonb NOT NULL, "total_length" bigint NOT NULL, "sha256" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "memory_artifact_read_receipts_owner_created_idx" ON "memory_artifact_read_receipts"("user_id","created_at");
