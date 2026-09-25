CREATE TABLE IF NOT EXISTS job_review_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id text NOT NULL REFERENCES job_leads(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('kept', 'application', 'reply', 'interview', 'offer')),
  occurred_on date NOT NULL,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lead_id, event_type, occurred_on)
);
CREATE INDEX IF NOT EXISTS job_review_events_occurred_idx ON job_review_events (occurred_on, event_type);
CREATE INDEX IF NOT EXISTS job_review_events_lead_idx ON job_review_events (lead_id, occurred_on DESC);

CREATE TABLE IF NOT EXISTS job_review_weeks (
  week_start date PRIMARY KEY,
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
