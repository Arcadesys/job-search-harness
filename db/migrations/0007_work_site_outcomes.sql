CREATE TABLE IF NOT EXISTS work_site_outcomes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  outcome_type text NOT NULL CHECK (outcome_type IN ('hiring_inquiry', 'conversation_booked')),
  occurred_on date NOT NULL,
  evidence_ref text NOT NULL CHECK (length(btrim(evidence_ref)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outcome_type, evidence_ref)
);
CREATE INDEX IF NOT EXISTS work_site_outcomes_occurred_idx ON work_site_outcomes (occurred_on, outcome_type);
