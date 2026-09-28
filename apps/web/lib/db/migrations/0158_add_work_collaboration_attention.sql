ALTER TABLE work_collaboration_requests
  ADD COLUMN due_at timestamptz NOT NULL DEFAULT (now() + interval '48 hours'),
  ADD COLUMN attention_reason text,
  ADD COLUMN attention_at timestamptz;

CREATE INDEX IF NOT EXISTS work_collaboration_attention_idx
  ON work_collaboration_requests(owner_id, due_at)
  WHERE status IN ('delivered', 'accepted', 'needs_info', 'replied');
