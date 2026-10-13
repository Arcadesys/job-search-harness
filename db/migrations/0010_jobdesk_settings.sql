-- Per-install preferences (time zone, drafting provider). Secrets such as API
-- keys never live here: backups export every table, so keys stay in a private
-- file outside the database.
CREATE TABLE IF NOT EXISTS jobdesk_settings (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-zA-Z]{0,63}$'),
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
