-- Assistant activity: one row per call over the local worker connection.
-- Summaries are structural (counts, states, identifiers); never claim or posting text.
CREATE TABLE jobdesk_activity (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  tool text NOT NULL DEFAULT '',
  method text NOT NULL,
  ok boolean NOT NULL,
  kind text NOT NULL CHECK (kind IN ('read','saved','lease','collect','needs_you','receipt','error')),
  summary text NOT NULL,
  lead_id text,
  item_id uuid
);
CREATE INDEX jobdesk_activity_recent ON jobdesk_activity (at DESC);
