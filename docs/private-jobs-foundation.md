# Private jobs foundation setup

This feature uses Auth.js GitHub OAuth with a JWT session and Neon Postgres for private resume-truth data. The allowlist is `JOBS_GITHUB_ACCOUNT_IDS`, a comma-separated list of numeric GitHub account IDs. The login callback checks the stable GitHub provider account ID, and each page or API read checks the allowlist again.

Configure `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `AUTH_SECRET`, `JOBS_GITHUB_ACCOUNT_IDS`, and `NEON_DATABASE_URL` in the deployment environment. Register `https://work.thearcades.me/api/auth/callback/github` as the GitHub OAuth callback URL. Set the allowlist value to the intended account's numeric ID; no account ID is hard-coded in application code.

Apply `db/migrations/0001_resume_truth.sql` to the Neon database before enabling the workspace. The first authenticated read idempotently seeds claims from the current `lib/resume.ts`. Every seeded claim has a source note and `unreviewed` status. Claim edits append immutable rows to `resume_truth_versions` in the same SQL statement that updates the current claim.

Apply `db/migrations/0002_job_discovery.sql` to enable the private lead inbox and application pipeline. The daily `/api/jobs/discovery` cron requires `CRON_SECRET` as a Bearer token and polls the Google Alerts RSS feeds configured in `/jobs`. Create matching alerts at Google Alerts and paste their RSS URLs into the private page; the displayed query terms are reference labels. Missing or failed feeds are reported in the run status. Feed polls are reserved atomically up to 300 per calendar month. Each UTC date can have one successful run; failed runs can be retried. Add discovered postings as unverified leads: feed snippets are only discovery hints, and a person must open the original URL to verify status. Manual leads and saved pipeline decisions remain private to the authorized GitHub account.

`/api/jobs/drafting-export` creates a private JSON handoff containing kept leads and only reviewed resume claims with source notes. It requires the authorized GitHub session, sends no-store headers, and returns a downloadable attachment. The public resume remains sourced from `lib/resume.ts`.

The public resume remains sourced from `lib/resume.ts`; private review state and edits live only in Postgres. `/jobs` declares `noindex,nofollow`, is excluded from the sitemap, and is disallowed in robots.txt. Analytics initialization, navigation, and click collection skip the `/jobs` route tree.
