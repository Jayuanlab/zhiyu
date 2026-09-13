CREATE TABLE runtime_instances (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "User"(id),
  mode text NOT NULL CHECK (mode IN ('worker','embedded')),
  desired_status text NOT NULL DEFAULT 'running' CHECK (desired_status IN ('running','paused','stopped')),
  phase text NOT NULL DEFAULT 'running' CHECK (phase IN ('running','stopping','stopped','lost')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  stopped_at timestamptz,
  modules jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(modules)='array'),
  UNIQUE(owner_id,id)
);
--> statement-breakpoint
CREATE TABLE runtime_owner_leases (
  owner_id uuid PRIMARY KEY REFERENCES "User"(id),
  instance_id uuid NOT NULL,
  token integer NOT NULL CHECK (token>0),
  lease_until timestamptz NOT NULL,
  FOREIGN KEY(owner_id,instance_id) REFERENCES runtime_instances(owner_id,id)
);
--> statement-breakpoint
CREATE INDEX runtime_instances_owner_started_idx ON runtime_instances(owner_id,started_at DESC);
