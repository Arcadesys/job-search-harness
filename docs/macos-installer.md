# macOS installer (Claude Desktop)

This is a self-contained, **unsigned and unnotarized** preview. No Node.js, npm, Terminal commands or administrator password are needed for a normal installation. Download the artifact matching the Mac CPU from the **macOS installer** GitHub Actions run. The archive includes Node 22 and the pinned application dependencies.

1. Unzip the archive locally, outside iCloud/Dropbox. Double-click **Install Job Search Harness.command**. macOS may require **right-click → Open** for this unsigned command; inspect its source if concerned.
2. Confirm the local installation and the separate Claude Desktop MCP settings change. Only the `job-search-harness` server entry is added. Conflicting entries stop installation rather than being overwritten.
3. Restart Claude Desktop after the installer completes. Double-click **Open Job Search Harness.command** inside `~/Library/Application Support/Job Search Harness App/` to open a fresh private browser session. You can also drag an alias to the Dock.

The app files live in `~/Library/Application Support/Job Search Harness App/`. The private PGlite database, approved truths, backups and secrets remain in the existing per-user data folder selected by `services/jobdesk/paths.mjs`. A user LaunchAgent (`me.thearcades.job-search-harness`) starts Jobdesk at login and restarts it on crashes. It uses a local broker, never a public listener. The per-user LaunchAgent creates no admin privilege requirement.

## Upgrades and recovery

Installing a newer ZIP stages the application before switching it. A running **installer-managed** LaunchAgent is stopped first. Any other owner, stale lock, or unfamiliar Claude entry causes a safe refusal. Do not delete a lock without using the existing `recover-lock` procedure and reconciling uncertain submissions. Data folders and API keys are not touched by the installer.

If service launch fails, the previous executable and LaunchAgent file are restored. If macOS refuses to launch, inspect the private `owner.log` and the LaunchAgent status using `launchctl print gui/$(id -u)/me.thearcades.job-search-harness`. Do not repeatedly delete or recreate the database. To retry the installer, use the same ZIP; unrelated Claude settings are preserved.

A manual Node installation can be migrated by stopping its background owner with the old `npm run jobs:cli -- stop-background` before installing. Its existing private data remains in place. Existing MCP configuration pointing elsewhere must be reviewed and changed intentionally, not silently replaced.

To stop the installer-managed background service, use `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/me.thearcades.job-search-harness.plist`. Do not remove private data or assume uninstalling the executable removes secrets.

## Verification

Automated: `node --test packaging/macos/install.test.mjs`; cross-platform application CI remains unchanged. Packaging CI runs natively on Intel and Apple Silicon and produces two ZIP artifacts.

**Physical macOS testing still needed:** Gatekeeper/open behavior, first login and reboot, both CPU architectures, Claude Desktop tool discovery and restart, login-agent crash recovery, upgrade from an active earlier manual process, permissions, and the browser launch experience. The workflow artifacts are unsigned previews, **not** notarized releases.