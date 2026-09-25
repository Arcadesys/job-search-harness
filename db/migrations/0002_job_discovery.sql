CREATE TABLE IF NOT EXISTS job_search_queries (
  id text PRIMARY KEY,
  lane text NOT NULL,
  location text NOT NULL,
  query text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_leads (
  id text PRIMARY KEY,
  source_url text NOT NULL UNIQUE,
  title text NOT NULL,
  organization text NOT NULL DEFAULT '',
  location text NOT NULL DEFAULT '',
  snippet text NOT NULL DEFAULT '',
  source text NOT NULL,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'verified', 'stale', 'unavailable')),
  decision text NOT NULL DEFAULT 'review' CHECK (decision IN ('review', 'keep', 'pass')),
  application_stage text CHECK (application_stage IN ('researching', 'preparing', 'applied', 'interviewing', 'offer', 'closed')),
  next_action text NOT NULL DEFAULT '',
  next_action_date date,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_leads_pipeline_idx ON job_leads (decision, application_stage, discovered_at DESC);

CREATE TABLE IF NOT EXISTS job_search_runs (
  run_date date PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  queries_attempted integer NOT NULL DEFAULT 0,
  results_seen integer NOT NULL DEFAULT 0,
  new_leads integer NOT NULL DEFAULT 0,
  calls_used integer NOT NULL DEFAULT 0,
  error_message text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS job_search_usage (
  usage_month date PRIMARY KEY,
  calls_used integer NOT NULL DEFAULT 0 CHECK (calls_used >= 0),
  call_cap integer NOT NULL DEFAULT 300 CHECK (call_cap = 300),
  updated_at timestamptz NOT NULL DEFAULT now()
);
