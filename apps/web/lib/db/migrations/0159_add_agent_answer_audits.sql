CREATE TABLE agent_answer_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigserial NOT NULL,
  owner_id uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL,
  chat_id uuid NOT NULL REFERENCES "Chat"(id) ON DELETE CASCADE,
  assistant_message_id uuid NOT NULL,
  work_id uuid,
  event_key text NOT NULL,
  event_type text NOT NULL,
  request_key text,
  request_payload_hash text,
  schema_version text NOT NULL,
  rule_version text NOT NULL,
  runtime_hash text NOT NULL,
  payload_hash text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_answer_audits_request_check CHECK (
    (event_type = 'turn_started' AND request_key IS NOT NULL AND request_payload_hash IS NOT NULL)
    OR (event_type <> 'turn_started' AND request_key IS NULL AND request_payload_hash IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_answer_audits_event_key_idx ON agent_answer_audits(owner_id, turn_id, event_key);
CREATE UNIQUE INDEX agent_answer_audits_request_key_idx ON agent_answer_audits(owner_id, request_key) WHERE event_type = 'turn_started';
CREATE UNIQUE INDEX agent_answer_audits_turn_start_idx ON agent_answer_audits(turn_id) WHERE event_type = 'turn_started';
CREATE UNIQUE INDEX agent_answer_audits_assistant_start_idx ON agent_answer_audits(assistant_message_id) WHERE event_type = 'turn_started';
CREATE INDEX agent_answer_audits_turn_seq_idx ON agent_answer_audits(owner_id, turn_id, seq);
CREATE INDEX agent_answer_audits_message_idx ON agent_answer_audits(owner_id, chat_id, assistant_message_id);
