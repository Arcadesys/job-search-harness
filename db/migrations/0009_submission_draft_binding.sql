-- Preserve the exact draft used at the submission boundary, even after edits.
-- Legacy unbound attempts stay visible for manual reconciliation and cannot
-- be silently promoted to a bound confirmation by the service.
ALTER TABLE jobdesk_submission_attempts ADD COLUMN draft_version text;
ALTER TABLE jobdesk_submission_attempts ADD COLUMN draft_hash text CHECK (draft_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE jobdesk_submission_attempts ADD COLUMN draft_snapshot jsonb;
ALTER TABLE job_application_receipts ADD COLUMN attempt_id uuid REFERENCES jobdesk_submission_attempts(id);
ALTER TABLE job_application_receipts ADD COLUMN draft_version text;
ALTER TABLE job_application_receipts ADD COLUMN draft_hash text CHECK (draft_hash ~ '^[a-f0-9]{64}$');
