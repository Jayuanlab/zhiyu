CREATE TABLE IF NOT EXISTS workshop_chat_work_items (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  workshop_id uuid NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
  source_message_id uuid NOT NULL,
  primary_directive_id uuid REFERENCES workshop_directives(id) ON DELETE SET NULL,
  latest_run_id uuid REFERENCES workshop_runs(id) ON DELETE SET NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  status text NOT NULL DEFAULT 'queued',
  intent_text text NOT NULL,
  result_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, chat_id, source_message_id)
);
CREATE INDEX IF NOT EXISTS workshop_chat_work_items_run_idx ON workshop_chat_work_items(latest_run_id);
CREATE TABLE IF NOT EXISTS workshop_chat_contexts (
  owner_id uuid NOT NULL,
  chat_id uuid NOT NULL REFERENCES "Chat"(id) ON DELETE CASCADE,
  workshop_id uuid REFERENCES workshops(id) ON DELETE SET NULL,
  work_item_id uuid REFERENCES workshop_chat_work_items(id) ON DELETE SET NULL,
  run_id uuid REFERENCES workshop_runs(id) ON DELETE SET NULL,
  last_user_message_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, chat_id)
);
CREATE TABLE IF NOT EXISTS workshop_chat_deliveries (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  workshop_id uuid NOT NULL,
  run_id uuid NOT NULL,
  source_message_id uuid,
  message_id uuid NOT NULL UNIQUE,
  run_status text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (run_id, run_status)
);
CREATE INDEX IF NOT EXISTS workshop_chat_deliveries_pending_idx ON workshop_chat_deliveries(status, next_attempt_at);

-- Recover old chat cards only from a matching successful owner command and
-- original persisted user turn. YAML reviews and browser storage are not focus.
INSERT INTO workshop_chat_work_items(id,owner_id,chat_id,workshop_id,source_message_id,latest_run_id,intent_text,status,created_at,updated_at)
SELECT DISTINCT ON (w.user_id,c.id,m.id) r.id,w.user_id,c.id,w.id,m.id,r.id,
  r.trigger_reason->>'prompt',
  CASE WHEN r.status='completed' AND EXISTS(SELECT 1 FROM workshop_events e WHERE e.run_id=r.id AND e.type='directive_needs_clarification') THEN 'needs_input'
    WHEN r.status='completed' THEN 'awaiting_acceptance' ELSE r.status END,r.created_at,r.updated_at
FROM workshop_runs r JOIN workshops w ON w.id=r.workshop_id
JOIN "Chat" c ON c.id::text=r.trigger_reason->>'chatId' AND c."userId"=w.user_id
JOIN "Message_v2" m ON m.id::text=r.trigger_reason->>'userMessageId' AND m."chatId"=c.id AND m.role='user'
JOIN work_commands cmd ON cmd.owner_id=w.user_id AND cmd.target_id=w.id
  AND cmd.command_id=r.trigger_reason->'commandMeta'->>'commandId'
WHERE r.trigger_reason->>'source'='web_chat' AND r.trigger_reason->>'origin'='chat_command'
  AND cmd.status='succeeded' AND cmd.type='startWorkRun'
  AND cmd.payload->'value'->>'source'='chat_agent'
  AND cmd.result->'value'->'run'->>'id'=r.id::text
  AND cmd.payload->'value'->'triggerReason'->>'prompt'=r.trigger_reason->>'prompt'
  AND cmd.payload->'value'->'triggerReason'->>'chatId'=c.id::text
  AND cmd.payload->'value'->'triggerReason'->>'userMessageId'=m.id::text
  AND (SELECT string_agg(p.value->>'text','' ORDER BY p.ordinality)
       FROM json_array_elements(CASE WHEN json_typeof(m.parts)='array' THEN m.parts ELSE '[]'::json END) WITH ORDINALITY p
       WHERE p.value->>'type'='text' AND json_typeof(p.value->'text')='string')=r.trigger_reason->>'prompt'
ORDER BY w.user_id,c.id,m.id,r.created_at DESC,r.id
ON CONFLICT DO NOTHING;
INSERT INTO workshop_chat_contexts(owner_id,chat_id,workshop_id,work_item_id,run_id,last_user_message_id,updated_at)
SELECT DISTINCT ON (i.owner_id,i.chat_id) i.owner_id,i.chat_id,i.workshop_id,i.id,i.latest_run_id,i.source_message_id,i.created_at
FROM workshop_chat_work_items i JOIN "Chat" c ON c.id=i.chat_id AND c."userId"=i.owner_id
ORDER BY i.owner_id,i.chat_id,i.created_at DESC,i.id
ON CONFLICT DO NOTHING;
