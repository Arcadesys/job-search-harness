# Local Jobdesk

This branch implements the reviewed fresh local PGlite design. It does not cut
over the installed plugin, hosted jobs API, or Vercel cron. The public portfolio,
`lib/resume.ts`, published PDF, and newsletter are independent of this service.

## Foreground use after review

From this checkout, with the locked dependencies installed:

```sh
npm run jobs:start
```

The service owns `~/Library/Application Support/Arcades Jobdesk/`, outside Git
and synced folders. It applies checksummed migrations before serving requests,
then listens on a user-only `broker.sock` and HTTP `127.0.0.1:4317`. An exclusive
owner lock prevents a second PGlite instance. Shut down with Control-C; no launch
agent or persistent scheduler is installed. Laptop sleep pauses local work.

Use another terminal to open an authenticated browser session:

```sh
npm run jobs:cli -- status
npm run jobs:cli -- open
```

The open command obtains a one-use, one-minute launch ticket over the private
socket, opens the browser, and removes the URL fragment after exchange. The
browser uses an eight-hour in-memory HttpOnly/SameSite=Strict session and a CSRF
token. Restarting the service invalidates sessions. Unexpected Host/Origin,
forwarded headers, cross-site requests, missing sessions, and invalid CSRF are
rejected. The local server is a separate frontend; hosted OAuth is preserved.

The cockpit reuses `JobsShell` and the complete `TruthEditor`. It includes lead
review, batches, original posting capture, saved draft review/editing, PDF review
packets, search settings, weekly activity, and submission reconciliation. It
uses validated domain methods through the sole owner. There is no SQL endpoint.

For an alternative private directory, set both `JOBDESK_DATA_DIR` for the
foreground owner and `JOBDESK_SOCKET` for clients. Directory roots must belong to
the current user, have permissions 0700, and be outside Git and recognized cloud
sync folders. PGlite 0.5.8 is pinned. Migration checksum drift, ledger gaps, or a
newer schema fail closed. Existing local stores are backed up before upgrades.

## Worker adapter

The installed consumer was inspected at
`~/.codex/plugins/cache/personal/job-hunt/0.1.0+codex.20260925191619/mcp/server.mjs`.
It is a Node stdio server with a fixed hosted REST origin and request-time
Keychain access. This branch includes a separately reviewable local adapter:

```sh
npm run jobs:mcp
```

It preserves the five verified tool names and argument schemas in
`docs/jobs-mcp-api.md`. It uses private Unix IPC, never opens the database, reads
no Keychain token, and has no hosted fallback. Only MCP JSON-RPC is written to
stdout. Configure a supported local client to launch
`node /absolute/checkout/services/jobdesk/mcp-server.mjs` only at approved cutover.
The currently installed plugin configuration remains unchanged.

The local adapter adds `job_hunt_renew_lease`, `job_hunt_begin_submission`, and
`job_hunt_mark_submission_uncertain`. These names are new branch functionality,
not claims about the previously installed plugin. Setting an item to preparing
atomically claims its 120-second lease; the worker renews it during preparation.
Stale generations cannot update the item. Before clicking Submit, the worker
must read the approved draft used to fill the form and pass its `draftVersion`
and `draftHash` to `job_hunt_begin_submission`. The broker rejects a changed
version, content hash, approval, or claim snapshot. On stale rejection, read the
current approved draft and refill the form before retrying. The durable attempt
retains that exact version, hash, and content snapshot; its confirmation receipt
inherits the attempt's binding even if the saved draft is edited afterward.

Definitive stale-lease errors clear the MCP adapter's cached lease. Setting an
item to preparing can reacquire it once before any submission dispatch. A
pending/uncertain attempt or an ambiguous begin response prevents automatic
reclaim and another submission; reconcile it first. The same MCP process resets
its attempt cache only after the broker confirms its exact attempt is
`not_submitted` and the item was explicitly requeued, with no open/confirmed attempt.

Submission takes place outside Jobdesk and still requires the user's employer
action authorization. After observing confirmation, the existing receipt tool
records it. Receipt, item, lead, weekly event, and attempt update are atomic.
Same-key retries return the receipt; conflicting receipts fail. A timeout or
owner restart leaves the attempt uncertain and prevents another claim, batch,
or requeue. Inspect employer confirmation/history before reconciliation. If
evidence establishes no submission, record that evidence; pending and uncertain
attempts atomically block the item and clear/fence the old lease. A deliberate
requeue and a new claim are required before further preparation. No browser or model operation spans a DB
transaction. The service serializes domain requests; model work can delay other
requests while in flight.

## Fresh-start facts and reviews

All baseline résumé claims start unreviewed, with source notes. Approvals are not
inherited from the hosted database. Claim versions, stale-batch conflicts,
independent duplicate wording, and saved draft snapshots are retained. Changed
wording/sources invalidate draft approval. New and edited drafts require review.
PDFs are labelled review packets and registered with hashes, draft version,
saved claim versions, and approval state.

Bootstrap reads optional provenance-labelled user reports from the private
data root's `bootstrap.json`. Actual application IDs and source notes stay
outside Git. Submitted reports and expected referrals are separate history,
not browser-confirmation receipts or inferred direct applications. Reported
submitted job IDs cannot be queued again. Confirmed weekly application totals
continue to count receipts only. Tests use synthetic employers and role IDs.

Discovery is manual. The six existing Google Alert feeds, UTC daily successful
scan dedupe, monthly poll cap, and Chicago weekly reporting remain. Import
extracted LinkedIn lead fields through the broker:

```sh
npm run jobs:import < extracted-leads.json
```

Imports remain unverified and deduplicate canonical URLs. No email credentials
or full email bodies are stored. A stopped local broker fails rather than
switching to Neon. The original import script's hosted invocation remains for
rollback. `JOBS_STORAGE_MODE=local` also prevents accidental hosted SQL fallback.

Drafting uses an existing provider key supplied to the foreground process. This
change does not create or configure credentials. The existing model and $8.50
monthly estimator are retained; confirm current provider availability/pricing
before enabling real calls at cutover. Missing reviewed claims/posting evidence
or keys block drafting. Failed/unmeasured calls close the cap. Interrupted
durable model markers close the corresponding month's cap on restart.

## Backups and recovery

```sh
npm run jobs:cli -- backup
npm run jobs:cli -- restore /absolute/backup/directory /absolute/new/private/directory
```

Backup admission runs through the owner, quiesces operations, and uses PGlite's
supported `dumpDataDir`, not a hot directory copy. Each snapshot includes a
runtime/migration/checksum manifest, a JSON logical table export, and registry
artifact hashes plus copies. Credentials and sessions are not exported. Restore
requires a new directory, checks the runtime and dump/artifact hashes, stages
verified artifact bytes under the owner lock before any upgrade backup, then opens
and verifies the migration ledger. Inspect the restored store before promotion;
there is no automatic active-directory overwrite or configuration switch.

The dump/load mechanism follows the [PGlite API](https://pglite.dev/docs/api).
For a runtime minor-version change, use the
[documented logical upgrade path](https://pglite.dev/docs/upgrade), rather than
treating binary dumps as a cross-version format. Keep seven daily and four
weekly snapshots when operating backups; retention and off-device backup are
not automatically configured by this branch.

If a crash leaves `owner.lock`, use `npm run jobs:cli -- recover-lock` after the
owner stops. Recovery proves the recorded PID is absent and checks the lock did
not change. It never replays submissions. A live owner or ambiguous lock is
rejected. Do not delete locks while workers are active.

## Review and cutover gates

1. Parent reviews this draft PR and its recorded validation. Merge/deploy requires
   the applicable approval; no rollout is performed by these instructions.
2. Choose the foreground directory and supported local client. Review baseline
   claims, provider availability/pricing, and the separate user-reported history.
3. Start the owner; launch the cockpit and point the chosen client at the local
   adapter. Test a read and synthetic preparation before employer work.
4. At separately approved cutover, stop cloud jobs writes and remove only
   `/api/jobs/discovery` from Vercel cron. Preserve the newsletter cron and public
   settings. Token revocation, persistent scheduling, remote access, and cloud
   retirement require their own approval. Avoid dual writes.
5. For rollback, stop local workers, back up local state, restore prior client
   configuration, and reconcile all post-cutover submissions. The hosted
   backend is a dated snapshot; never overwrite local state from it automatically.

See `docs/local-jobdesk-validation.md` for measured evidence and limitations.
