ALTER TABLE job_leads ADD COLUMN last_seen_at timestamptz;
ALTER TABLE job_leads ADD COLUMN posting_retrieved_at timestamptz;
ALTER TABLE job_leads ADD COLUMN user_verified_at timestamptz;

CREATE TABLE job_collection_runs (
  id uuid PRIMARY KEY,
  source text NOT NULL,
  state text NOT NULL CHECK (state IN ('running','complete','partial','failed')),
  coverage text NOT NULL,
  request jsonb NOT NULL,
  pending jsonb NOT NULL DEFAULT '[]',
  counts jsonb NOT NULL DEFAULT '{"requested":0,"fetched":0,"parsed":0,"failed":0,"saved":0}',
  errors jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE job_source_observations (
  id uuid PRIMARY KEY,
  run_id uuid REFERENCES job_collection_runs(id),
  lead_id text NOT NULL REFERENCES job_leads(id),
  source text NOT NULL,
  source_key text NOT NULL,
  content_hash text NOT NULL,
  record jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_observations_lead ON job_source_observations(lead_id, observed_at DESC);
CREATE TABLE job_source_records (
  source text NOT NULL,
  source_key text NOT NULL,
  lead_id text NOT NULL REFERENCES job_leads(id),
  content_hash text NOT NULL,
  record jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_key)
);
CREATE TABLE job_exclusions (
  id uuid PRIMARY KEY,
  lead_id text NOT NULL REFERENCES job_leads(id),
  input_hash text NOT NULL,
  rule text NOT NULL,
  evidence text NOT NULL,
  restored_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(lead_id, input_hash, rule)
);
CREATE TABLE job_work_stages (
  id uuid PRIMARY KEY,
  lead_id text NOT NULL REFERENCES job_leads(id),
  stage text NOT NULL CHECK (stage IN ('assessment','selection')),
  input_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','complete','stale','needs_attention')),
  result jsonb,
  attempts integer NOT NULL DEFAULT 0,
  error text NOT NULL DEFAULT '',
  input_bytes integer NOT NULL DEFAULT 0,
  output_bytes integer NOT NULL DEFAULT 0,
  input_tokens integer,
  output_tokens integer,
  provider_cost numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(lead_id, stage, input_hash)
);
CREATE TABLE job_material_manifests (
  id uuid PRIMARY KEY,
  lead_id text NOT NULL REFERENCES job_leads(id),
  selection_id uuid NOT NULL REFERENCES job_work_stages(id),
  input_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','current','stale','needs_attention')),
  manifest jsonb NOT NULL,
  artifacts jsonb NOT NULL DEFAULT '[]',
  validation jsonb NOT NULL DEFAULT '{}',
  attempts integer NOT NULL DEFAULT 0,
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(lead_id,input_hash)
);
ALTER TABLE job_application_drafts ADD COLUMN material_manifest_id uuid REFERENCES job_material_manifests(id);
ALTER TABLE jobdesk_artifacts ADD COLUMN kind text NOT NULL DEFAULT 'review';
