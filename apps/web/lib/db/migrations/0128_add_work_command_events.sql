-- Command audit survives deletion of its target Work.
CREATE TABLE work_command_events (
  seq bigserial PRIMARY KEY,
  owner_id uuid NOT NULL,
  command_id varchar(256) NOT NULL,
  target_id uuid NOT NULL,
  phase varchar(20) NOT NULL CHECK (phase IN ('accepted','succeeded','failed')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner_id,command_id) REFERENCES work_commands(owner_id,command_id) ON DELETE CASCADE,
  UNIQUE(owner_id,command_id,phase)
);
