# Electron desktop app

The desktop wrapper opens the local cockpit in a sandboxed Electron window.
Node.js is included in the `.app`; the installed app needs no separate Node or
npm installation. This first package targets the Mac architecture doing the
build. It is an ad hoc signed local preview, not a notarized release.

## Build and install

```sh
npm ci
npm run build
```

The output on Apple Silicon is
`dist/Job Search Harness-darwin-arm64/Job Search Harness.app` (Intel uses
`darwin-x64`). The drag-to-Applications disk image is
`dist/Job Search Harness-arm64.dmg` (Intel uses `x64`). Open the DMG, drag the
`.app` to Applications, and open it there. The bundle signature is checked during
packaging; a Developer ID and notarization are not configured. The app's
View menu provides keyboard zoom and fullscreen controls. New windows start at
125% zoom. External job links open in the default browser.

For development, run `npm run desktop`.

## Private data and owner lifetime

The app uses `services/jobdesk/paths.mjs`, including an existing legacy Arcades
Jobdesk directory on macOS. It reuses a healthy running owner with matching migrations and never replaces
an owner lock. If there is no owner, it starts the existing background owner
using Electron's bundled Node runtime. New owners use a free loopback port.

Closing or quitting the desktop window leaves that owner running for MCP access.
Use the existing `jobs:cli -- stop-background` command for an owner started by
this launcher. An owner from a different migration version must be stopped using that version’s documented command before opening the app. A stale or unresponsive owner stops startup and requires the
existing recovery procedure. The app never deletes locks to force startup.

Electron's browser session files live separately in
`~/Library/Application Support/Job Search Harness Desktop`. Résumé claims,
applications, artifacts, secrets and backups remain in the private jobdesk data
folder. Nothing changes Claude Desktop or Codex MCP configuration automatically.

To point an MCP client at the self-contained app, use the executable inside
`Job Search Harness.app/Contents/MacOS/Job Search Harness` with environment
`ELECTRON_RUN_AS_NODE=1` and argument
`Job Search Harness.app/Contents/Resources/app/services/jobdesk/mcp-server.mjs`.
Use absolute paths for both. Review client settings before changing them.

## Validation

Validate the packaged app with an isolated `JOBDESK_DATA_DIR`,
`JOBDESK_DESKTOP_USER_DATA_DIR` and `JOBDESK_PORT=0`: cockpit load, navigation, keyboard focus, zoom/reflow, renderer
isolation, owner reuse, and persistence across a window restart. Stop only the
owner created for that temporary directory. Testing a development Electron
window alone does not establish that the packaged app works.
