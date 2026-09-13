CREATE TABLE brain_backfill_batches (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
 mapping_version text NOT NULL, request_hash text NOT NULL, plan_hash text NOT NULL,
 source_cursor uuid, next_cursor uuid, status text NOT NULL DEFAULT 'planned',
 approved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX brain_backfill_batches_owner_idx ON brain_backfill_batches(user_id, created_at);
--> statement-breakpoint
CREATE TABLE brain_backfill_items (
 batch_id uuid NOT NULL REFERENCES brain_backfill_batches(id) ON DELETE CASCADE,
 memory_id uuid NOT NULL, ordinal integer NOT NULL,
 status text NOT NULL, before_hash text NOT NULL, after_hash text,
 before_values jsonb NOT NULL, changes jsonb NOT NULL, detail jsonb NOT NULL,
 PRIMARY KEY(batch_id,memory_id), UNIQUE(batch_id,ordinal)
);
--> statement-breakpoint
CREATE TABLE brain_backfill_events (
 id bigserial PRIMARY KEY, batch_id uuid NOT NULL REFERENCES brain_backfill_batches(id) ON DELETE CASCADE,
 kind text NOT NULL, memory_id uuid, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
