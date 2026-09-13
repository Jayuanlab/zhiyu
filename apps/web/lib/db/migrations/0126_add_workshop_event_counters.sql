-- Apply with all event writers paused. Old max(seq)+1 writers must not coexist
-- with the new allocator after rollout.
CREATE TABLE IF NOT EXISTS workshop_event_counters (
  workshop_id uuid PRIMARY KEY REFERENCES workshops(id) ON DELETE CASCADE,
  last_seq integer NOT NULL DEFAULT 0 CHECK (last_seq >= 0)
);
--> statement-breakpoint
INSERT INTO workshop_event_counters (workshop_id, last_seq)
SELECT w.id, COALESCE(max(e.seq), 0)
FROM workshops w LEFT JOIN workshop_events e ON e.workshop_id = w.id
GROUP BY w.id
ON CONFLICT (workshop_id) DO UPDATE
SET last_seq = GREATEST(workshop_event_counters.last_seq, EXCLUDED.last_seq);
