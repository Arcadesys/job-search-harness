CREATE TABLE IF NOT EXISTS job_mcp_tokens (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  label text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_mcp_tokens_owner_created_idx
  ON job_mcp_tokens (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS job_application_batches (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_id)
);
CREATE INDEX IF NOT EXISTS job_application_batches_owner_created_idx
  ON job_application_batches (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS job_application_batch_selections (
  owner_id text PRIMARY KEY,
  batch_id uuid NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (batch_id, owner_id) REFERENCES job_application_batches(id, owner_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS job_application_batch_items (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES job_application_batches(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  lead_id text NOT NULL REFERENCES job_leads(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'preparing', 'awaiting_approval', 'submitted', 'blocked', 'skipped')),
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, lead_id),
  UNIQUE (id, owner_id)
);
CREATE INDEX IF NOT EXISTS job_application_batch_items_owner_batch_idx
  ON job_application_batch_items (owner_id, batch_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS job_application_batch_items_one_active_application_idx
  ON job_application_batch_items (owner_id, lead_id)
  WHERE status IN ('queued', 'preparing', 'awaiting_approval', 'submitted');

CREATE TABLE IF NOT EXISTS job_application_receipts (
  id uuid PRIMARY KEY,
  item_id uuid NOT NULL UNIQUE REFERENCES job_application_batch_items(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  idempotency_key text NOT NULL,
  confirmation text NOT NULL,
  confirmation_url text NOT NULL DEFAULT '',
  confirmed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, idempotency_key)
);
