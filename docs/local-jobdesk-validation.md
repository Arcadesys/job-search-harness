# Local Jobdesk validation

Validated on the selected Mac, 1 October 2026, from an isolated checkout based on
`193fc7b858caf4c8ace307bdbecde047230f9ac8`. PGlite is pinned to 0.5.8. Tests use
temporary private directories, synthetic employer records, mocked feed/model
responses, and a separately spawned stdio worker. No employer was contacted.

The review follow-up reran all six local disk/domain/IPC tests, TypeScript,
scoped service lint, and whitespace checks after the submission/lease fixes.
The existing unit, browser, full lint, and production-build rows below were
measured on `367c641`; their affected public/UI code is unchanged by the follow-up.

| Check | Result | Evidence |
| --- | --- | --- |
| Existing unit tests | 123 passed | `node --import tsx --test lib/*.test.ts` |
| Local disk/domain/IPC tests | 6 comprehensive tests passed | `npm run test:jobdesk` |
| Local desktop/mobile cockpit | 2 passed | `npm run test:jobdesk:browser` |
| Existing truth-review browser suite | 21 passed | `npm run test:truths` |
| Public portfolio/newsletter browser suite | 33 passed | `npm run test:browser` |
| TypeScript | Passed | `npx next typegen`; `npx tsc --noEmit` |
| Lint | Zero errors | Three existing public image warnings |
| Production build | Passed | `npm run build`, no jobs DB configured |
| Whitespace | Passed | `git diff --check` |

The local tests exercise all migrations 0001–0009 on real disk, repeated startup,
checksum drift, unsupported/gapped schema, failed DDL rollback, pre-upgrade
backup, duplicate owner rejection, explicit dead-PID recovery, and private file
permissions. Backup tests load a supported binary dump into another directory
and run the restore CLI, verifying registry artifact bytes and hashes.

Business-rule coverage includes concurrent optimistic claim review, only one
winning worker lease, expiry/generation fencing, preparation resumption after
draft review, user-reported history separated from receipts, URL/email dedupe,
submitted/application-stage barriers, reviewed-only drafting, snapshot
preservation, empty/stale draft approval rejection, uncertainty blocking
requeue/new batches, idempotent/conflicting receipts, and atomic receipt/event/
applied-stage/attempt writes. No tests use actual employer receipts.

The review regressions exercise worker-read A followed by reviewed draft B,
stale version and content-hash rejection, attempt snapshot/receipt binding after
later draft edits, and persistence of those bindings after backup and restart.
They cover pending/uncertain reconciliation blocking and fencing the old lease,
explicit requeue before another attempt, one long-lived MCP client's renewal
and status expiry recovery, no reclaim after submission dispatch, and ambiguous
begin-response blocking. A forced receipt-binding constraint failure proves
the receipt/event/applied-stage/attempt transaction rolls back together.
The same adapter remains alive through pending and uncertain reconciliation,
requires explicit requeue, then obtains a fresh claim and begins a new attempt.
An actual CLI restore starts from migrations 0001–0008 with a registered PDF,
stages its verified bytes before the migration 0009 pre-upgrade backup, and
checks the restored PDF and that backup's artifact bytes and original ledger.

Real SQL tests check monthly reservations, a successful scan's UTC date dedupe,
cap exhaustion without another feed call, unmeasured and failed model-call
budget closure, interrupted model-marker recovery, and Chicago dates across
both daylight saving transitions. Provider calls are mocked; current model
availability/pricing and actual credentials still need review before real use.

The IPC test uses the actual loopback server, one-use session exchange,
cookie/CSRF checks, unexpected Host/Origin/cross-site rejection, logout,
unauthenticated calls, rejected arbitrary SQL methods, and an actual child
stdio MCP process. It checks the five preserved tool names and protocol-only
stdout. An unavailable broker fails closed. This does not claim the installed
plugin/client configuration has been switched; that remains a cutover gate.

The local browser flow checks the session launch fragment is removed, keyboard
approval, cancel/back guards, failed-save retry, 200% text reflow, lead creation,
lead review, and queued batch display at desktop and mobile widths. The existing
truth suite covers independent related claims, stale batches, history, restart,
keyboard order, contrast, target sizes, and narrow-screen reflow. Public browser
checks cover hiring/contact paths and newsletter confirmation/cancel/retry with
jobs storage unavailable; real newsletter messages are not sent.

An isolated foreground probe measured 847 ms startup and 584 MiB process RSS
after five idle seconds. Integration-test startup was approximately 1.2–1.8
seconds, with test-process RSS approximately 587–1078 MiB. The latter includes
test runner/modules. These are short observations, not a sustained steady-state
benchmark or performance guarantee. The service currently serializes
domain operations; a model request can delay other UI/worker requests. No remote
access, unattended scheduler, backup retention, off-device backup, or persistent
launch service has been installed.

The temporary Playwright browser cache used for validation is under `/tmp`.
Browser evidence is also outside Git. The actual private bootstrap reports are
outside this repository; tracked fixtures contain synthetic reports only.

Parent review, client configuration, provider review, durable foreground launch,
and the separately approved cloud-jobs cutover remain outstanding. The hosted
backend, public resume/PDF, public URLs, and newsletter cron are preserved.
