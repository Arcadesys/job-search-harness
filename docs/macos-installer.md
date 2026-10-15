# macOS installer (Claude Desktop)

This is a self-contained, **unsigned and unnotarized** preview. No Node.js, npm, Terminal commands or administrator password are needed for a normal installation. Download the artifact matching the Mac CPU from the **macOS installer** GitHub Actions run. The archive includes Node 22 and the pinned application dependencies.

1. Unzip the archive locally, outside iCloud/Dropbox. Double-click **Install Job Search Harness.command**. macOS may require **right-click → Open** for this unsigned command; inspect its source if concerned.
2. Confirm the local installation and the separate Claude Desktop MCP settings change. Only the `job-search-harness` server entry is added. Conflicting entries stop installation rather than being overwritten.
3. Restart Claude Desktop after the installer completes. Double-click **Open Job Search Harness.command** inside `~/Library/Application Support/Job Search Harness App/` to open a fresh private browser session. You can also drag an alias to the Dock.

The app files live in `~/Library/Application Support/Job Search Harness App/`. This installer opens the cockpit in your browser; it does not create an Electron `.app` in Applications. The private PGlite database, approved truths, backups and secrets remain in the existing per-user data folder selected by `services/jobdesk/paths.mjs`. An existing legacy Arcades Jobdesk folder stays authoritative; the installer does not create a replacement empty store. A user LaunchAgent (`me.thearcades.job-search-harness`) starts Jobdesk at login and restarts it on crashes. Its loopback port is assigned automatically, and the opener obtains the current private session over the broker. The per-user LaunchAgent creates no admin privilege requirement.

Installation succeeds only after the LaunchAgent PID matches the database owner and its broker answers a health request. Claude settings are written afterwards, and installation refuses to overwrite a settings file changed while it was staging. The opener reads the selected data folder and agent label from the installed private `installation.json`.

## Upgrades and recovery

Installing a newer ZIP stages the application before switching it. A running **installer-managed** LaunchAgent is stopped first. Any other owner, stale lock, or unfamiliar Claude entry causes a safe refusal. Do not delete a lock without using the existing `recover-lock` procedure and reconciling uncertain submissions. Data folders and API keys are not touched by the installer.

If service launch fails, the previous executable and LaunchAgent file are restored after the new owner closes. Private data and migrations are never rewound automatically; an upgrade can apply migrations before failing, so inspect the migration backups and the recorded error before retrying. A failure to stop or restore an agent is reported explicitly, retaining the runtime needed for recovery. If macOS refuses to launch, inspect the private `owner.log` and the LaunchAgent status using `launchctl print gui/$(id -u)/me.thearcades.job-search-harness`. Do not repeatedly delete or recreate the database. Unrelated Claude settings are preserved.

A manual Node installation can be migrated by stopping its background owner with the old `npm run jobs:cli -- stop-background` before installing. Its existing private data remains in place. Existing MCP configuration pointing elsewhere must be reviewed and changed intentionally, not silently replaced.

To stop the installer-managed background service, use `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/me.thearcades.job-search-harness.plist`. Do not remove private data or assume uninstalling the executable removes secrets.

## Verification

Automated: `npm run test:installer`; cross-platform application CI remains unchanged. The 13 tests use isolated home, app, data and Claude settings paths. They cover legacy folder reuse, repeat installation, consent, configuration collisions/concurrent edits, shell-special paths, dangling symlinks, private permissions and launch/readiness rollback. Packaging CI runs natively on Intel and Apple Silicon and produces two ZIP artifacts.

Local Apple Silicon verification on 2026-10-15 used the packaged official Node 22.23.3 runtime, an isolated legacy data directory and a dedicated real LaunchAgent label. Fresh installation reached matching owner/agent PID plus broker health with all 13 migrations. The installed stdio adapter completed MCP initialization and tool discovery. Repeat installation and a simulated post-start failure with actual runtime/agent rollback both retained a saved fictional truth, a data marker and unrelated Claude settings. All temporary agents and stores were removed afterwards.

The installed cockpit rendered at 1440×1000 and 390×844, with keyboard skip-link focus, Settings navigation, 200% reflow, no horizontal page overflow, no page exceptions and no axe WCAG A/AA violations. Browser plugin was not available; these checks used Playwright Chromium. Library, jobdesk, résumé evaluation and browser suites passed locally; focused entry-point checks cover canonical/symlinked paths for startup guards.

## Build locally

```sh
npm ci
JOBDESK_PACKAGE_NODE=/path/to/official-node-22/bin/node npm run package:macos
```

Use the official Node 22 macOS archive from nodejs.org and verify it against that release's `SHASUMS256.txt`. A Homebrew Node that depends on Homebrew libraries is not a self-contained runtime; the build rejects non-system dynamic libraries. The runtime architecture must match the Mac doing the build.

The command installs only lockfile-pinned production dependencies into an allowlisted payload, verifies the copied Node can bundle the cockpit, and writes `dist/job-search-harness-macos-arm64.zip` or `dist/job-search-harness-macos-x64.zip`. It includes no environment files, private store or personal configuration. CI uses this same command with its official Node 22 runtime.

**Manual verification still needed:** Gatekeeper/Finder first-open behavior, login and reboot, Intel hardware, Claude Desktop's actual connection after restart, login-agent crash recovery, and migration from an active manual process. The workflow artifacts are unsigned previews, not notarized releases. The isolated LaunchAgent/stdio/browser checks above do not establish these outcomes.
