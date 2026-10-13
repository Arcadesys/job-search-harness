# MCP tools

`services/jobdesk/mcp-server.mjs` is a dependency-free stdio MCP server. It
talks only to the local owner over its private broker, never opens the
database, and has no network fallback: if the jobdesk is not running, every
tool fails with that message. Only JSON-RPC is written to stdout. None of these
tools submits anything to an employer.

## Setup

| Tool | What it does |
| --- | --- |
| `job_hunt_setup_status` | Counts truths (total, reviewed, unreviewed), searches and feeds, reports the time zone, and names the next step. |
| `job_hunt_import_resume` | First import of the user's own résumé, copied verbatim and grouped by role. Fails without changes once any truth exists. Every claim arrives unreviewed. |
| `job_hunt_add_resume_text` | Adds more claims, one per line; wording already present is skipped. |

## Applying

| Tool | What it does |
| --- | --- |
| `job_hunt_list_batches` | The user's application batches and which one is selected, with counts per state. |
| `job_hunt_list_batch_items` | Items in a batch: role, organization, location, source URL, verification and status. |
| `job_hunt_get_item` | One item with its saved draft, the draft's approval, `draftVersion` and `draftHash`, and the user's reviewed truths. |
| `job_hunt_update_item_status` | `preparing` (claims the lease), `awaiting_approval`, `blocked` or `skipped`, with a note. It cannot mark an item submitted. |
| `job_hunt_renew_lease` | Keeps the preparation lease alive; a stale worker cannot write. |
| `job_hunt_begin_submission` | Records a durable attempt bound to the exact approved draft (`draftVersion`, `draftHash`) immediately before the user's employer action. Refused if the draft changed. |
| `job_hunt_mark_submission_uncertain` | Blocks an interrupted attempt for reconciliation. |
| `job_hunt_record_submission` | After the employer's confirmation is seen, saves one receipt per item (idempotent by key), marks it submitted and counts it in the weekly review. |

The receipt is the worker's report of what the employer showed; the jobdesk
cannot see the employer's system. A timeout, restart or ambiguous response
leaves the attempt uncertain, and the item cannot be claimed, requeued or
batched again until the user reconciles it in the cockpit.

Lease, draft-binding and receipt rules are described in
[local-jobdesk.md](local-jobdesk.md#drafts-and-submissions).
