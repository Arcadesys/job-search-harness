CREATE TABLE job_search_brief_messages (
  id text PRIMARY KEY,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE job_search_brief_versions (
  version integer PRIMARY KEY CHECK (version > 0),
  draft jsonb NOT NULL,
  content_hash text NOT NULL UNIQUE,
  approved_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE job_search_brief_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  draft_version integer REFERENCES job_search_brief_versions(version),
  active_version integer REFERENCES job_search_brief_versions(version)
);
INSERT INTO job_search_brief_state(singleton) VALUES (true);
