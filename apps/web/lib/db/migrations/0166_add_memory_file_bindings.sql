CREATE TABLE memory_file_import_receipts (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
 command_id varchar(200) NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 task_chat_id uuid NOT NULL, relative_path text NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), size_bytes bigint NOT NULL CHECK(size_bytes > 0), file_stat jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','recorded')),
 artifact_id uuid REFERENCES memory_artifact_manifests(id) ON DELETE CASCADE, artifact_revision text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT memory_file_import_state_check CHECK(state <> 'recorded' OR (artifact_id IS NOT NULL AND artifact_revision IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX memory_file_import_owner_command_idx ON memory_file_import_receipts(user_id,command_id);
--> statement-breakpoint
CREATE TABLE memory_file_bindings (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
 workshop_id uuid NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
 source_id uuid NOT NULL REFERENCES workshop_sources(id) ON DELETE CASCADE,
 artifact_id uuid NOT NULL REFERENCES memory_artifact_manifests(id) ON DELETE CASCADE, artifact_revision text NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision >= 1), state text NOT NULL CHECK(state IN ('active','revoked')),
 permissions jsonb NOT NULL CHECK(jsonb_typeof(permissions)='array' AND permissions <@ '["read","convert"]'::jsonb AND jsonb_array_length(permissions)>0),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX memory_file_binding_owner_source_idx ON memory_file_bindings(user_id,source_id);
--> statement-breakpoint
CREATE INDEX memory_file_binding_work_state_idx ON memory_file_bindings(user_id,workshop_id,state);
--> statement-breakpoint
CREATE TABLE memory_file_binding_commands (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
 command_id varchar(200) NOT NULL, request_hash text NOT NULL,
 binding_id uuid NOT NULL REFERENCES memory_file_bindings(id) ON DELETE CASCADE,
 from_revision integer NOT NULL, to_revision integer NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX memory_file_binding_command_owner_idx ON memory_file_binding_commands(user_id,command_id);
--> statement-breakpoint
CREATE TABLE memory_work_file_upload_intents (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
 command_id varchar(200) NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 workshop_id uuid NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
 source_id uuid, state text NOT NULL CHECK(state IN ('pending','recorded')), result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT memory_work_file_upload_state_check CHECK(state <> 'recorded' OR (source_id IS NOT NULL AND result IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX memory_work_file_upload_owner_command_idx ON memory_work_file_upload_intents(user_id,command_id);
