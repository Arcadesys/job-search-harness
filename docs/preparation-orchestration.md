# Approved-brief preparation orchestration

This slice connects the search brief contract to Jobdesk's existing durable work stages. It adds no scheduler, model provider, collection run, or submission executor. It does not activate Daily Job Radar.

## Intake and approval boundary

All methods use the existing `{ method, args }` RPC envelope. The authenticated, same-origin, CSRF-protected cockpit endpoint can call:

- `brief.addMessage`: `[{ id, text }]`. Store a message typed by the user, with a stable client-generated ID. Retrying identical content is safe; reusing an ID for changed content is rejected. Only these stored messages can supply proposal quotes.
- `brief.read`: `[]`. Return stored messages, current draft and review hash/questions, and active approved parameters.
- `brief.propose`: `[{ proposal, expectedDraftHash }]`. Use the proposal schema in `lib/search-brief.ts`; cite exact stored user quotes. `null` means no pending draft. A model may propose interpretations and clarification questions but cannot approve them.
- `brief.approve`: `[{ reviewedHash, expectedActiveHash }]`. Display the full review summary, classifications and unresolved questions before the user explicitly approves. Pass the exact draft hash displayed and the active hash seen, or `null` before first approval. The server constructs the approval snapshot and timestamp.
- `brief.cancelDraft`: `[{ expectedDraftHash }]`. Abandon only the pending draft; the approved version stays active.

Broker/MCP callers can read and propose, but cannot add user messages, approve, or cancel a draft. Trusted capability is supplied by the HTTP server after browser authentication and CSRF validation, never by an RPC argument. This is a transport boundary, not cryptographic proof of human presence: arbitrary code running as the same local OS user remains privileged. UI implementation must never automatically call approval on a model's behalf.

Writes are serialized and transactional. An identical proposal retry reuses its pending version. An approval retry for the active hash is a no-op, even if a newer draft is waiting. Stale revisions or approvals fail rather than overwrite another review. Cancelled versions remain in history; version numbers are never reused. The first pass limits intake to 100 messages and a proposal to 30 criteria/24,000 characters, with interpreted criteria capped at 4,000 UTF-8 bytes to reserve workflow packet space. No transcript reset or active-brief deactivation is provided yet.

## Versioned decisions and artifacts

Before the first approval, existing settings and hashes behave as before. A pending first draft pauses the planner for review; a pending revision leaves the current approved brief usable.

An approved brief replaces legacy free-form criteria in workflow packets. Its `{ briefId, version, contentHash }` identity participates in assessment, selection and material fingerprints. Approval refreshes saved workflow state transactionally. Old results cannot be saved against a newly approved version; old artifacts remain historical but lose current readiness. Existing human keep/pass decisions, source truths, and submission receipts are preserved.

Hard requirements, preferences, dealbreakers and unresolved tradeoffs remain separate. Existing legacy automatic exclusion rules stop running while a structured brief is active. This pass does not translate typed criteria into automatic hard filters; assessment receives the approved parameters and supporting provenance remains available through `brief.read`. Quote validation establishes provenance, not semantic correctness, which still requires user review.

## Resumable per-job plan

`preparation.plan([{ leadId }])` (MCP: `job_hunt_preparation_plan`) returns one `nextAction`, reason, whether preparation can resume, whether a user decision is required, current stage references and approved brief identity. `automaticSubmission` is always false. Tool hints identify existing bounded operations without executing them.

The planner selects stages by current input hashes, not latest timestamps. It prioritizes uncertain/pending submission reconciliation, terminal application states, human pass, first-brief review, posting verification, assessment, human keep, exact-claim selection, material rendering/repair, visual inspection, and current draft approval. It preserves existing two-attempt limits and never duplicates a pending render. Missing or invalid material prerequisites stop for attention. The RPC refreshes stale-state markers but performs no provider, rendering or external work.

A ready result is a snapshot, not a submission authorization or lease. Existing downstream checks must revalidate state immediately before any consequential operation. Cancellation here applies only to a draft brief; running render and submission recovery continue using their existing machinery.

## Next integration boundary

The résumé evaluation fixtures from PR #6 remain offline oracles, not production golden answers for arbitrary users. A production artifact-bound deterministic check and saved advisory recruiter-review stage can be added next. This slice does not claim semantic résumé quality, predict recruiter outcomes, or silently spend a model budget. It does not expose the intake UI; Claude Design can bind the cockpit methods above.

## Validation

Run `npm run typecheck`, `npm run lint`, `node --import tsx --test --test-concurrency=1 lib/*.test.ts`, and `node --import tsx --test services/jobdesk/preparation.test.ts`. Tests use synthetic fixtures and in-memory PGlite migrations, with no personal uploads or model charges. Existing file-backed/HTTP integration suites still belong in normal CI; sandbox filesystem/socket restrictions are not weakened to run them.

Validated locally: 112/112 library tests, 4/4 orchestration integration tests, full typecheck and lint. Run the two PGlite suites sequentially in memory-limited sandboxes; overlapping runs were terminated without assertion reports here. Standard CI still uses the existing test commands.
