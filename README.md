# Job Search Harness

A private job-search workspace that runs on your own computer. Your AI assistant
(Claude or ChatGPT) helps you find roles, prepare applications and keep track of
them, but it can only use résumé claims you have approved, and nothing counts as
submitted until you have the employer's confirmation.

- **Private by design.** Everything lives in a folder on your computer. There is
  no account, cloud database or analytics.
- **No invented experience.** You import your own résumé, approve each claim,
  and drafts are built from those exact words.
- **Works with the assistant you already use.** Claude Desktop, the ChatGPT
  desktop app (Codex mode) or Codex connect to it through MCP.

The design is written up at
[work.thearcades.me/work/job-search-cockpit](https://work.thearcades.me/work/job-search-cockpit).

## Install

1. **Download** the installer for your computer from the
   [latest release](https://github.com/Arcadesys/job-search-harness/releases/latest):
   - **Mac:** the `.dmg` (`arm64` for Apple silicon, `x64` for older Intel Macs). Open it and drag
     Job Search Harness into Applications.
   - **Windows:** the `.exe`. Run it; it installs for you only and needs no administrator rights.
   - **Linux:** the `.AppImage` (make it executable and run it) or the `.deb` for Ubuntu and Debian.
2. **Open Job Search Harness.** A short setup guide walks you through three steps:
   - **Connect your AI.** One click adds the app to Claude Desktop or the ChatGPT desktop app
     (Codex). You stay signed in to your assistant as usual; this app never sees your password.
     Restart the assistant afterwards. You can also paste an Anthropic or OpenAI API key to
     draft inside the app instead.
   - **Say what you want:** the role, place, minimum salary and employers to skip.
   - **Add your résumé:** choose a PDF or Word file, or paste the text. It is read on your
     computer, and each line becomes a claim you approve before it is used.

The app keeps running in the menu bar (Mac) or system tray (Windows) so your assistant can reach
it, and your assistant starts it again if it is closed.

> **Unsigned builds.** Until the releases are code-signed, your computer warns about an
> unidentified developer. On a Mac, right-click the app, choose **Open**, then **Open** again.
> On Windows, choose **More info**, then **Run anyway**.

Used the earlier macOS installer preview? Install the app; it takes over the same data and
Claude connection on first launch ([details](docs/desktop-release.md#upgrading-from-the-macos-installer-preview)).

Prefer the command line, or contributing? See [Development](#development); a source checkout
needs [Node.js 22 or later](https://nodejs.org/) and connects with
`node /full/path/to/services/jobdesk/mcp-server.mjs` as the MCP command.

## Get started

1. **Add your résumé.** Attach it in Claude or ChatGPT and say *"Import my résumé
   into Job Search Harness."* Or paste it on the Résumé truths page.
2. **Review your claims** on the Résumé truths page. Only approved claims can be
   used in a draft.
3. **Add your searches** in Settings: one per kind of role and place, each with
   an optional Google Alert RSS feed.
4. **Save jobs you want**, add the original posting, and ask your assistant to
   prepare the application. You approve the draft before anything is sent.

The **Discovery and preparation** view can collect a bounded Built In Chicago
pilot or your enabled feeds, show collection health, and save recoverable
exclusions. Your assistant reviews compact work packets and selects exact approved
claims; the harness assembles a résumé and a separate private review packet.
Unchanged work is reused. See [durable workflows](docs/durable-workflows.md).

The jobdesk runs while your computer is awake. Restart it after a reboot with
`npm run jobs:cli -- start-background`, and stop it with
`npm run jobs:cli -- stop-background`. Create a backup anytime in Settings.

Drafting inside the workspace, without an assistant, is optional: choose
Anthropic or OpenAI in Settings and paste your own API key. Keys stay in a
private file on your computer, outside the database and its backups.

## Platforms

macOS, Windows and Linux. Your data is in:

- **macOS:** `~/Library/Application Support/Job Search Harness`
- **Windows:** `%LOCALAPPDATA%\Job Search Harness`
- **Linux:** `~/.local/share/job-search-harness`

## Development

```sh
npm install
npm run typecheck && npm run lint
npm test                   # library tests
npm run test:jobdesk       # owner, broker, MCP and migration tests
npx playwright install chromium
npm run test:jobdesk:browser && npm run test:truths
npm start                  # foreground owner on 127.0.0.1:4317
npm run desktop            # build and open the desktop app
npm run desktop:dist       # build installers for this platform into release/
xvfb-run -a npm run test:desktop   # first-run test of the staged app (no xvfb on macOS/Windows)
```

| Path | What it is |
| --- | --- |
| `services/jobdesk` | Owner, broker, CLI, MCP adapter (`mcp-server.mjs`) and cockpit UI |
| `desktop/` | Electron app: window, tray, owner start-up; see [desktop releases](docs/desktop-release.md) |
| `lib/` | Truths, discovery, drafting, queue, review, settings and PDF rendering |
| `db/migrations` | Checksummed migrations; never edit one that has shipped |
| `docs/` | [Jobdesk design](docs/local-jobdesk.md) and [MCP tools](docs/jobs-mcp-api.md) |

CI runs every check on macOS, Windows and Linux.

## Provenance

Split out of [Arcadesys/work-thearcades-me](https://github.com/Arcadesys/work-thearcades-me)
on 2026-10-13 with filtered history; PR numbers in older commit messages refer
to that repository. The tag `hosted-final` marks the last version with the
retired hosted cockpit (Next.js, Neon and GitHub sign-in).
