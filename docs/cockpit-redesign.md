# Cockpit redesign integration

The cockpit uses the existing private store and approved-claim workflow. Today
offers Mission control, Board and Journeys; the chosen layout is saved in the
browser. The activity feed shows structural MCP call summaries and live leases,
without copying claim, posting, draft or API-key text into its log.

## Upgrade and authority

The new, unreleased activity migration is `0014_assistant_activity.sql`. It
follows the 13 migrations already on main; inserting its earlier PR filename
`0012_assistant_activity.sql` into that sequence would reject existing stores.
Shipped SQL files and their checksums are unchanged. A disk-backed upgrade test
compares existing truths, leads and the migration ledger, verifies the automatic
pre-upgrade backup, and verifies activity persistence across restart. A store
created by an earlier unpublished PR snapshot must be reconciled explicitly;
the migrator continues to reject unknown or reordered migration ledgers.

Only a saved employer receipt advances the cockpit to Submitted. A user-reported
application stage remains labelled as reported. Draft approval and submission
authorization remain separate, and browser requests cannot record a submission.

## Accessibility and local verification

At narrow widths, Assistant activity is a native modal dialog: focus stays in
the panel, Escape closes it, and focus returns to the opener. At wide widths it
is a docked aside. Root font changes recalculate docking so large text retains
space for the main column. Background activity polling does not move focus.

Local checks covered typecheck, lint, library/jobdesk tests, résumé evaluations,
installer tests and both browser suites. Nine routes at 1440 and 390 pixels
produced no WCAG A/AA axe violations, page exceptions or horizontal page overflow.
Additional checks covered 200% root text, layout persistence, keyboard scrolling
and modal focus/close/return. Browser plugin was unavailable; Playwright
Chromium was used. The packaged Node 22 runtime also passed actual temporary
LaunchAgent install, MCP discovery, repeat install, persistence and rollback
checks with all 14 migrations. No real user store or assistant settings changed.
