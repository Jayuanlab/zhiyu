CREATE INDEX IF NOT EXISTS "workshop_events_workshop_type_seq_idx"
ON "workshop_events" ("workshop_id", "type", "seq");
