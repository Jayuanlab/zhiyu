-- Model-derived input is immutable once prepared; retries reuse the same draft.
ALTER TABLE work_commands ADD COLUMN prepared_payload jsonb;
ALTER TABLE work_commands ADD COLUMN prepared_at timestamptz;
ALTER TABLE work_commands ADD COLUMN preparation_error varchar(100);
