# Desktop app and releases

The desktop app is an Electron wrapper around the same owner, cockpit and MCP adapter that a
source checkout runs. It adds no network calls of its own and has no automatic updates.

## How it fits together

- `desktop/main.ts` sets `JOBDESK_RESOURCES` to the packaged app, starts the owner in-process
  (or reuses a background owner started from the command line), and opens the cockpit with a
  fresh one-time ticket every time the window is shown. On macOS and Windows it stays in the
  menu bar or tray; on Linux, closing the window quits.
- After a force quit the owner lock outlives its process. The app calls `recoverOwnerLock`, which
  proves the old process is gone before removing the lock. It never touches leases or attempts.
- The four dependency-free MCP scripts are copied to `<data folder> (app)/mcp/<version>/` on each
  launch, so the path an assistant stores survives app moves and AppImage remounts. Assistants
  run them with the app's own runtime (`ELECTRON_RUN_AS_NODE=1`); no separate Node.js is needed.
- `services/jobdesk/assistants.ts` writes the `job-search-harness` entry into Claude Desktop's
  `claude_desktop_config.json` or Codex's `config.toml`. It changes only that entry, keeps a
  `.before-job-search-harness` copy, refuses to touch a file it cannot parse, and repairs its own
  entry on launch if the app moved. Only the cockpit can call `assistant.connect`, not the worker.
- If the owner is not running, the MCP adapter starts the app with `--background` (from
  `JOBDESK_APP`) and retries only calls that never reached the owner, so nothing runs twice.
- Résumé files are posted to `/api/resume/extract`, read in memory (PDF with pdf.js, Word with
  mammoth) and never stored. The person checks the text before any line becomes a claim.
- Chromium's spellchecker is off on Linux, where it would download dictionaries.

## Building

```sh
npm run desktop:stage     # dist/app: bundled main, prebuilt cockpit, migrations, fonts, MCP scripts
npm run desktop:dist      # installers for this platform in release/
```

Only PGlite and pdf.js ship as packages; everything else is bundled into `dist/app/main.cjs`.
Icons are drawn by `node scripts/make-icons.mjs`.

## Releasing

The **Desktop app** workflow builds the `.dmg` (Apple silicon and Intel), Windows `.exe`, and
Linux `.AppImage` and `.deb` on every pull request, runs the first-run test against each packaged
app, and uploads the installers as run artifacts. Pushing a tag such as `v0.2.0` also publishes
them to a draft GitHub release; bump `version` in `package.json` first, check the draft, then
publish it.

## Signing

Builds are unsigned until these repository secrets exist. Signing then turns on by itself.

| Secret | Used for |
| --- | --- |
| `MAC_CERTIFICATE_P12_BASE64`, `MAC_CERTIFICATE_PASSWORD` | Developer ID Application certificate (Apple Developer Program) |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarization, so macOS opens the app without a warning |
| `WINDOWS_CERTIFICATE_P12_BASE64`, `WINDOWS_CERTIFICATE_PASSWORD` | An OV or EV code-signing certificate exported as .p12 |

Many Windows certificates now live only in a hardware token or a cloud service such as Azure
Trusted Signing, which electron-builder supports through `win.azureSignOptions`; that needs a
small change to `electron-builder.config.cjs`.
