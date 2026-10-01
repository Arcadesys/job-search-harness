-- Local broker metadata. Hosted tables and migrations remain usable for rollback.
ALTER TABLE job_application_batch_items ADD COLUMN IF NOT EXISTS lease_worker text;
ALTER TABLE job_application_batch_items ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE job_application_batch_items ADD COLUMN IF NOT EXISTS lease_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE job_application_drafts ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'review_required'
  CHECK (review_status IN ('review_required', 'approved'));

CREATE TABLE IF NOT EXISTS jobdesk_submission_attempts (
  id uuid PRIMARY KEY,
  item_id uuid NOT NULL REFERENCES job_application_batch_items(id),
  owner_id text NOT NULL,
  worker_id text NOT NULL,
  lease_generation bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'uncertain', 'confirmed', 'not_submitted')),
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (item_id, owner_id) REFERENCES job_application_batch_items(id, owner_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS jobdesk_one_open_attempt_idx ON jobdesk_submission_attempts(item_id)
  WHERE state IN ('pending', 'uncertain');

CREATE TABLE IF NOT EXISTS jobdesk_user_reports (
  id text PRIMARY KEY,
  organization text NOT NULL,
  external_job_id text NOT NULL DEFAULT '',
  state text NOT NULL CHECK (state IN ('user_reported_submitted', 'referral_expected')),
  reported_on date NOT NULL,
  source_note text NOT NULL
);

CREATE TABLE IF NOT EXISTS jobdesk_artifacts (
  id uuid PRIMARY KEY,
  lead_id text NOT NULL REFERENCES job_leads(id),
  relative_path text NOT NULL UNIQUE,
  content_hash text NOT NULL,
  draft_version text NOT NULL,
  claim_versions jsonb NOT NULL,
  approval_state text NOT NULL DEFAULT 'review_required' CHECK (approval_state IN ('review_required', 'approved', 'superseded')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobdesk_model_runs (
  id uuid PRIMARY KEY,
  usage_month date NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','finished','interrupted')),
  created_at timestamptz NOT NULL DEFAULT now()
);
