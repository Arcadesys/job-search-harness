# Grouped résumé truth review

## Working checkpoint

- Route: implement the approved Concept B plan in one coordinator context; the page, data contract, and verification stay together. No delegation.
- State: grouped review, explicit batch approval, inline correction/rejection, related-wording comparison, and session undo implemented. No production truth data was changed.
- Evidence: 109 unit/database tests, 21 focused browser checks, and 24 existing browser checks passed. Build passed. Lint passed with three pre-existing public-page image warnings.
- Remaining boundary: merge/deployment and authenticated production acceptance are separate from these local results. Undo is session-scoped; saved approvals and immutable versions persist across reloads.

## Data and API

The existing GET and PATCH contracts remain compatible. GET also supplies a `version` token, retaining PostgreSQL timestamp precision as opaque text. New POST `/api/jobs/resume-truth` accepts `{ changes: [{ id, expectedVersion, reviewStatus, claim?, sourceNote? }] }` with 1–200 unique IDs. Authentication runs before validation/storage. Blank claim/source edits and invalid statuses fail validation.

The SQL locks all selected records in ID order, compares every expected version, and atomically updates records plus history only when none conflict. HTTP 409 reports stale/missing IDs and writes nothing. Success returns current claims, updated records, and progress. Undo uses the same version checks and appends history; it does not erase past versions. Legacy PATCH writes also invalidate batch tokens.

Grouping uses imported IDs and saved employer text. Eight known accomplishment/experience relationships additionally require their distinguishing wording on both records; ambiguous or edited-away relationships are not inferred. Related copies remain distinct and are selected separately. Filters display matching records individually, including copies otherwise behind comparison. Select-all only includes displayed unreviewed records.

Only reviewed records are projected into drafting exports, with their source notes. Public résumé source/PDF is unchanged.

## Render and accessibility evidence

Initial inspection used the Codex in-app browser with the real page components and isolated database. Automated checks and stable native-size screenshots use Playwright Chromium; the in-app full-page capture repeated a page segment, so it was not used for the comparison artifact.

The fixture renders production components/CSS and invokes the production POST handler/storage SQL against a temporary disk-backed PGlite PostgreSQL database. It replaces Next Link with ordinary local links and uses an explicit test-only account; it does not install an authentication bypass in the application. It binds only to loopback, never uses production credentials, and removes its database when stopped. Persistence is verified across database close/reopen and browser reload. This is not an authenticated deployment test.

Concept comparison was performed at 1536px width against the accepted 1536×1024 comp:

| Comparison | Result |
| --- | --- |
| Navigation and hierarchy | Horizontal Job Desk navigation, underlined current page, five section choices and a role-focused main panel retained. |
| Typography | Large sans-serif claims, clear heading scale and explicit status text; no raster text in the implementation. |
| Palette | Deep navy surfaces, bright text, yellow selection/approval, and visible borders retained. |
| Row anatomy | Full claims, independent checkboxes, saved status and labelled Edit actions retained. |
| Approval footer | Exact selected count, explicit approval action, separate Next role and Finish for now retained. |
| Source access | View source notes reveals each record's full source and history; kept out of the default reading flow. |
| Responsive behavior | Sections move above content; actions stack and navigation wraps at narrow sizes without nested scrolling. |

Intentional differences required by the approved behavior: a Choose role or filter disclosure, comparison controls, accurate totals including related copies, dynamic selection counts, and save/undo/error states. Seed data has 64 records, rather than the user's production screenshot's 65. Source wording is described as saved notes rather than asserting every record still has its original imported source. Existing drafting-packet download remains below the review area. No new career claims or unrelated product sections were added.

Above-the-fold copy check: navigation, title, privacy copy, section names, role heading, selection explanation, and approval action match the chosen direction. Dynamic counts and the explicitly planned filter/comparison controls account for the differences.

Checks cover 1536×1024, 390×844 and 320×720, including 200% root text size, no horizontal overflow, visible focus, tab-only selection/edit/comparison/approval, status announcements, 56px controls/checkbox labels, and zero axe WCAG A/AA findings in the main review view. No material visual discrepancies remain against Concept B plus the approved comparison/filter behavior.

## Reproduce

- `npm test` — includes real SQL, atomic stale-batch rejection, immutable undo history, authentication/validation, and restart persistence.
- `npm run test:truths` — isolated browser suite; does not require production sign-in or database access.
- `npm run test:browser` — existing site regression suite.
- `npm run lint` and `npm run build`.

For a manual local fixture: `npx tsx tests/fixtures/truth-review-server.ts`, then open `http://127.0.0.1:3101`. Stop the process when finished. This fixture uses public seed facts, not the user's private saved revisions.
