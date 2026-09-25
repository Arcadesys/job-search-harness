CREATE TABLE IF NOT EXISTS resume_truth_claims (
  id text PRIMARY KEY,
  claim text NOT NULL,
  source_note text NOT NULL,
  review_status text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed', 'reviewed', 'rejected')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resume_truth_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id text NOT NULL REFERENCES resume_truth_claims(id) ON DELETE CASCADE,
  claim text NOT NULL,
  source_note text NOT NULL,
  review_status text NOT NULL CHECK (review_status IN ('unreviewed', 'reviewed', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS resume_truth_versions_claim_created_idx
  ON resume_truth_versions (claim_id, created_at DESC);
