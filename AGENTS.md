# AGENTS.md

## Ground rules

- This is a local, single-user product for anyone. Never ship one person's data:
  no seeded résumé claims, searches, locations, employers or time zones. Tests
  use the fictional résumé in `tests/fixtures/sample-resume.ts`.
- Everything stays on the user's computer. No analytics, no hosted fallback, and
  no network calls except Google Alert feeds the user added and the drafting
  provider they chose. Keep `Cache-Control: private, no-store` on cockpit responses.
- Drafts are assembled only from claims the user approved. Do not add a path
  that lets a model write claim text that has not been reviewed.
- Nothing is recorded as submitted without a saved confirmation receipt, and
  the jobdesk never submits to an employer itself.
- API keys never enter the database, its backups, logs or `settings.read`.
- Never edit a shipped migration in `db/migrations`; add a new one. The jobdesk
  refuses checksum drift.
- Keep macOS, Windows and Linux working: take paths from
  `services/jobdesk/paths.mjs`, and keep tests portable (see
  `tests/fixtures/temp-root.ts`). CI runs on all three.
- Never stop jobdesk processes by name pattern: a user's real owner runs the
  same command. Stop only the PID you started, or use `stop-background` with
  its own `JOBDESK_DATA_DIR`.
