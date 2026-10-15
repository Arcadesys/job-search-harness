# Electron macOS checkpoint

## Outcome and scope

Self-contained Apple Silicon Electron app and drag-to-Applications DMG built from
merged main (`ce67603`, including PRs #2 and #8). Only desktop packaging, its
launcher, documentation and isolated checks changed. Original Electron WIP and
other worktrees remain intact.

## Route and decisions

Short architecture pass: keep the existing sole-owner broker and platform data
paths. Electron launches it with its bundled Node runtime; closing the window
leaves the broker available to assistants. Reuse matching healthy owners; refuse
older migration sets, unavailable owners and stale locks. Never stop or recover
a user's owner automatically. The renderer is sandboxed, isolated and has no
Node integration. Only HTTP(S) external links leave the app.

Bounded implementation/verification route: workhorse, medium effort requested.
This continued in the existing execution context; no model switch was enforced
and no agents were delegated.

## Current evidence (2026-10-15)

- `npm run build` creates the `.app` and compressed `.dmg`; only allowlisted
  source and production dependencies enter the payload. Electron 44.7.2 contains
  Node 24.21.0. A separate Node installation is unnecessary at runtime.
- `codesign --verify --deep --strict` passes for the packaged and installed app.
- DMG mounted read-only; contains the app plus `/Applications` symlink. Copied
  that app into `/Applications/Job Search Harness.app`, then unmounted the DMG.
- `npm run test:desktop -- '/Applications/Job Search Harness.app/Contents/MacOS/Job Search Harness'`
  passed: actual installed executable, authenticated cockpit, navigation,
  sandbox/context isolation, zero scanned WCAG A/AA violations, native 200% zoom
  reflow, keyboard modal focus/Escape/return, owner reuse and persisted fictional
  résumé claims across a full owner restart. All data and browser profiles were
  temporary and cleaned up; only those owners were shut down.
- `node --import tsx tests/desktop-owner-version.mjs '/Applications/Job Search Harness.app/Contents/MacOS/Job Search Harness'`
  passed: simulated older owner refused without a browser ticket, shutdown or
  lock modification.
- Typecheck, lint, diff whitespace checks passed. Library: 150 passed. Jobdesk:
  59 passed, one skipped. Installer: 13 passed.
- Local evidence: `/tmp/job-harness-electron-checks.json` and
  `/tmp/job-harness-electron-200-percent.png`.

## Limits and next step

Ad hoc signed local preview; no Developer ID or notarization. Intel and other
platform desktop packages were not validated. Existing private data and assistant
settings were not changed. An older running service must be stopped using its
own supported shutdown procedure before opening this version on that store.
Source changes can be reviewed separately from the working local artifacts.
