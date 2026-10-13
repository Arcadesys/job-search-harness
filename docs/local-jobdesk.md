# Jobdesk design

The jobdesk is the whole product: one local owner process holds a private
PGlite database, serves the cockpit on loopback, and answers a private broker
that the MCP adapter and CLI use. There is no hosted service, account or
cloud database. The hosted version that preceded it is tagged `hosted-final`.

## Where data lives

| Platform | Data folder | Broker |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Job Search Harness/` | `broker.sock` in that folder |
| Windows | `%LOCALAPPDATA%\Job Search Harness\` (never the roaming profile) | named pipe `\\.\pipe\job-search-harness-<hash of the folder>` |
| Linux | `$XDG_DATA_HOME/job-search-harness/` (default `~/.local/share/…`) | `broker.sock` in that folder |

An install from before the rename keeps using `~/Library/Application
Support/Arcades Jobdesk/` on macOS when that folder exists and the new one
does not; nothing is moved. `JOBDESK_DATA_DIR` overrides the folder for the
owner and its clients; `JOBDESK_SOCKET` overrides only where clients connect.
`services/jobdesk/paths.mjs` is the single source for these rules.

The folder must not be a symlink, inside a Git checkout, or inside iCloud,
Dropbox, OneDrive or Google Drive. On macOS and Linux it must belong to the
current user with mode 0700; Windows relies on the per-user profile. Unix
socket paths are capped near 104 bytes, and startup says so plainly if the
folder path is too long.

Inside the folder: `database/` (PGlite 0.5.8, pinned), `artifacts/` (review
PDFs), `backups/`, `owner.lock`, `owner-process.json` and `owner.log` for a
background owner, and `secrets.json` (API keys, mode 0600) once one is saved.

## Running the owner

```sh
npm run jobs:cli -- start-background   # or: npm start (foreground, Control-C to stop)
npm run jobs:cli -- status
npm run jobs:cli -- open                # one-use browser link
npm run jobs:cli -- stop-background
```

Startup takes an exclusive `owner.lock`, applies checksummed migrations (taking
a backup first when upgrading an existing store), marks any interrupted
submission attempt `uncertain`, and then listens. Migration checksum drift,
ledger gaps or a newer schema fail closed.

`start-background` launches an independent process session (no console window on
Windows), waits for a healthy broker, and records the exact lock it created in
`owner-process.json`. A healthy running owner is reused; an unhealthy one or a
stopped lock is refused. `stop-background` verifies that binding and asks the
owner to shut down over the broker (`owner.shutdown`, which the browser session
cannot call), so the database and lock close cleanly on every platform. It is a
manually started process, not a login item or crash supervisor: it survives the
launching terminal but not a reboot.

After a crash leaves `owner.lock`, `npm run jobs:cli -- recover-lock` removes it
only after proving the recorded PID is gone. It never replays submissions.

## The cockpit

`open` gets a one-use, one-minute ticket over the broker. The browser trades it
for an eight-hour HttpOnly, SameSite=Strict session plus a CSRF token; restarting
the owner ends sessions. Unexpected Host or Origin headers, forwarded headers and
cross-site requests are refused. The browser API cannot claim leases, begin or
record submissions, open new sessions or stop the owner. There is no SQL
endpoint: every call is a validated domain method run by the owner.

Views: Today (get-started checklist, batches, reconciliation when an item is
blocked), Leads, Résumé truths, Weekly review and Settings (searches, time zone,
optional drafting provider, backups). The UI is bundled at startup from
`services/jobdesk/ui.tsx` and `services/jobdesk/ui/`.

## Truths

A fresh install has no claims. They arrive three ways, always unreviewed with a
source note and a first immutable version:

- `truth.importResume` (MCP `job_hunt_import_resume`): a structured résumé the
  user's assistant extracted from their own document. Allowed once, while the
  bank is empty. IDs follow the shapes the editor groups by: `profile.*`,
  `summary`, `accomplishment.N`, `experience.N.{employer,title,dates,claim.M}`,
  `earlier.N`, `skills.N`, `education.N`, `other.N`.
- `truth.importText` (MCP `job_hunt_add_resume_text`, and the cockpit paste box):
  one claim per line as `other.N`, bullets stripped, existing wording skipped.
- `truth.addProject`: one `project.<slug>` claim; identical retries are no-ops.

None of these changes an existing claim, approval or history. Review happens in
the cockpit in batches with version checks, so a stale batch saves nothing.
Editing reviewed wording returns it to unreviewed. An accomplishment is shown
beside the one role bullet it clearly restates (word overlap at least 0.3 and at
least 0.2 ahead of the next bullet); otherwise it stays under Other claims.

## Drafts and submissions

Drafts come from approved claims only. The user's assistant can save one with
`draft.saveManual`, or the cockpit's optional assessment can prepare one with the
user's own Anthropic or OpenAI key. Either way the saved résumé text is assembled
from the exact approved claim wording, a snapshot of those claims is stored with
the draft, and the draft needs explicit approval. Changing a claim afterwards
invalidates that approval. The optional assessment also requires a verified
original posting, stops at an $8.50 monthly estimate, and closes the month on
any failed or unmeasured call.

The worker flow, with every guard enforced by the owner:

1. Setting an item to `preparing` claims a 120-second lease; the worker renews it.
   A stale lease generation cannot write.
2. Before clicking Submit, the worker passes the approved draft's `draftVersion`
   and `draftHash` to `job_hunt_begin_submission`. A changed draft, approval or
   claim snapshot is refused; read the current draft and refill the form.
3. The durable attempt keeps that exact draft snapshot. The confirmation receipt
   inherits it even if the draft is edited later.
4. After seeing the employer's confirmation, `job_hunt_record_submission` saves the
   receipt, item, lead stage, weekly event and attempt state in one transaction.
   Same-key retries return the same receipt.

A timeout or restart leaves the attempt `uncertain` and blocks another claim,
batch or requeue for that item. Check the employer's confirmation or history
first; if nothing was submitted, record that evidence in the cockpit, then
requeue deliberately. The jobdesk never submits to an employer itself.

## Discovery and history

Searches are the user's own (up to 20), each with an optional Google Alert RSS
feed. Scans run only when asked: one successful scan per UTC day, at most 300
feed polls a month. LinkedIn alert emails can be imported as leads with
`npm run jobs:import < extracted-leads.json`; no email credentials or bodies are
stored. Every lead stays unverified until its original posting is saved.

An optional `bootstrap.json` in the data folder records earlier, user-reported
applications so they cannot be queued again. Reported history is shown apart
from confirmed receipts, and weekly totals count receipts only. Weekly reviews
and receipt dates use the time zone in Settings, defaulting to the computer's.

## Backups

```sh
npm run jobs:cli -- backup
npm run jobs:cli -- restore /backup/directory /new/private/directory
```

Backups run through the owner using PGlite's `dumpDataDir`, with a manifest of
runtime, migrations and checksums, a logical JSON export, and hashed copies of
review PDFs. API keys and sessions are never included. Restore needs a new
folder, verifies every hash, and stages artifacts before any upgrade. Moving
between PGlite minor versions uses the [logical upgrade
path](https://pglite.dev/docs/upgrade), not binary dumps. Off-device backup is up
to the user.

`docs/local-jobdesk-validation.md` records the original validation of this design.
