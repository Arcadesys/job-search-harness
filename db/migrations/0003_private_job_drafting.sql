ALTER TABLE job_leads ADD COLUMN IF NOT EXISTS posting_text text NOT NULL DEFAULT '';
ALTER TABLE job_leads ADD COLUMN IF NOT EXISTS posting_source_note text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS job_ai_usage (
  usage_month date PRIMARY KEY,
  estimated_usd numeric(10,4) NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  unknown_cost_requests integer NOT NULL DEFAULT 0,
  request_count integer NOT NULL DEFAULT 0,
  budget_usd numeric(10,2) NOT NULL DEFAULT 8.50,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_fit_assessments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id text NOT NULL REFERENCES job_leads(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('ready','blocked')),
  assessment jsonb NOT NULL DEFAULT '{}'::jsonb,
  model text NOT NULL DEFAULT 'gpt-6-luna',
  input_tokens integer,
  output_tokens integer,
  estimated_usd numeric(10,6),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_fit_assessments_lead_idx ON job_fit_assessments(lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS job_application_drafts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id text NOT NULL REFERENCES job_leads(id) ON DELETE CASCADE,
  resume_variant text NOT NULL,
  outreach text NOT NULL,
  claim_ids text[] NOT NULL DEFAULT '{}',
  truth_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(lead_id)
);
