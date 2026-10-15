# Saved artifact review stages

This backend slice adds `resume_evaluation` and `recruiter_review` to the existing durable work-stage ledger. It does not run a model, start collection, or submit applications. UI integration is separate.

## What is checked

`evaluation.run([{leadId, retry?}])` reads the current employer PDF from its stored artifact path and independently extracts text. It checks the actual byte hash, current posting, approved claim versions/text/source notes, required profile/role facts, selection order and association, canonical document text, missing/extra/duplicate claims and private provenance leakage. Comparison allows wrapping whitespace differences. It does not use the synthetic fixture goldens or claim to measure semantic relevance, entailment, visual layout, or hiring outcomes.

The parser accepts at most 5 MiB, 20 pages and 100,000 extracted characters. Blank/image-only or unreadable PDFs produce an incomplete evaluation, never a pass. Dynamic evaluation and external-resource fetching are disabled. PDF.js is now a pinned runtime dependency because these checks run in the owner process.

Each result binds the exact artifact ID/hash, material ID/input hash, posting hash/text hash, claim snapshot/catalog hash, active approved brief identity, evaluator version and rubric version. Changes invalidate both review stages. Returning to an exact prior identity restores completed immutable history; incomplete work retains its attempt budget.

Generated-material approval and existing submission checks require a current passing deterministic evaluation in addition to existing visual review and byte-integrity checks. Manual drafts retain their existing path. A deterministic pass grants no approval.

## Advisory review contract

`recruiter.packet([{leadId, offset?, postingOffset?, claimOffset?}])` requires a current passing evaluation. It returns a bounded evidence packet and the exact binding. Follow independent résumé, posting and selected-claim continuations; character windows shrink to fit the UTF-8 byte budget. All source text and reviewer strings remain untrusted data.

`recruiter.save([{packetId, inputHash, result}])` accepts the strict `recruiter-live-1` schema:

- schemaVersion 1, exact binding, rubricVersion, reviewer label
- Up to 20 findings with category (`unsupported_implication`, `missing_evidence`, `relevance`, `clarity`), concern, selected claim IDs, exact résumé quote and/or exact posting quote
- Unsupported implications require résumé evidence; missing-evidence findings require posting evidence
- No score, self-approval, replacement claim text, or submission instruction fields

Citations prove source presence and identifier validity, not semantic correctness of the concern. The reviewer label is attribution supplied by the adapter, not authenticated human identity. Empty findings mean no concern was identified; they do not prove quality. All findings are advisory and require human judgment. This slice supplies no paid judge adapter.

`reviews.read([{leadId}])` returns current saved reports and findings without returning the full extracted résumé. MCP equivalents are `job_hunt_evaluate_resume`, `job_hunt_recruiter_packet`, `job_hunt_save_recruiter_review`, and `job_hunt_read_artifact_reviews`.

## Recovery and approvals

The evaluator persists its pending attempt before parsing, then revalidates the full binding before saving. A restart converts pending evaluations to attention-required; an explicit retry permits one more attempt. Repeated current completed evaluation calls reuse the result. A failed deterministic result stays failed until the artifact/input is revised or explicitly rebuilt. `workflow.build` with repair=true now performs a targeted rebuild even if the existing bytes are intact, while retaining its existing two-build limit.

Advisory validation permits at most two result attempts. Identical completed saves reuse the immutable review; different content cannot overwrite it. Stale packets are rejected. Passing checks, recording concerns, and reading plans never approve a draft, edit truths or submit.

The preparation planner orders visual inspection, deterministic evaluation, advisory review and then human draft approval. Advisory completion is a recommended preparation stage; the direct human approval boundary requires deterministic checks but does not give a reviewer veto. A plan remains a snapshot, and consequential endpoints revalidate current state. Existing submission receipts and uncertainty reconciliation retain priority.

## Validation

Use synthetic fixtures only:

- `npm run typecheck` and `npm run lint`
- `node --import tsx --test --test-concurrency=1 lib/*.test.ts`
- `node --import tsx --test services/jobdesk/artifact-review.test.ts`
- `npm run test:jobdesk` in normal CI, including existing workflow/fuzz regressions

Run memory-intensive PGlite suites sequentially in constrained environments. No production privacy or socket guard is disabled for testing.

Local final validation: 150/150 library tests, 14/14 in-memory artifact/planner integration tests, full lint and typecheck passed. Existing file-backed workflow/fuzz and browser suites remain for normal CI because this sandbox cannot run the production private-root/socket setup.
