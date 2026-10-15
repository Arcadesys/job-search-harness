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

**macOS desktop app (local preview):** run `npm ci` and `npm run build` on a Mac.
Open `dist/Job Search Harness-arm64.dmg` (Intel builds use `x64`), then drag
**Job Search Harness.app** into **Applications**. Open it from Applications.
The app includes Electron and Node; no separate runtime is needed. This preview
is ad hoc signed, without Developer ID notarization. See [desktop build and data
lifetime](docs/electron-desktop.md).

**macOS + Claude Desktop (preview):** download the self-contained Intel or Apple Silicon ZIP from the [macOS installer workflow](https://github.com/Arcadesys/job-search-harness/actions/workflows/macos-installer.yml), unzip it, and double-click **Install Job Search Harness.command**. Confirm the changes, restart Claude Desktop, then double-click **Open Job Search Harness.command** in the installed app folder. No separate Node installation or manual JSON editing is required. See [installation, upgrade and recovery details](docs/macos-installer.md). The preview is unsigned and needs real-Mac validation before a formal release.

**Manual installation (all platforms):** setup needs [Node.js 22 or later](https://nodejs.org/).

1. Download this repository (green **Code** button, then **Download ZIP**) and unzip it
   somewhere permanent, such as your Documents folder.
2. Open a terminal in that folder and run:

   ```sh
   npm install
   npm run jobs:cli -- start-background
   ```

3. Connect your assistant. Point it at `services/jobdesk/mcp-server.mjs` in that
   folder, using the full path:
   - **Claude Desktop:** Settings → Developer → Edit Config, then add
     ```json
     { "mcpServers": { "job-search-harness": { "command": "node", "args": ["/full/path/to/services/jobdesk/mcp-server.mjs"] } } }
     ```
   - **ChatGPT desktop (Codex mode) or Codex:** add to `~/.codex/config.toml`
     ```toml
     [mcp_servers.job-search-harness]
     command = "node"
     args = ["/full/path/to/services/jobdesk/mcp-server.mjs"]
     ```
   Restart the assistant afterwards.
4. Open your workspace with `npm run jobs:cli -- open`.

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
```

| Path | What it is |
| --- | --- |
| `services/jobdesk` | Owner, broker, CLI, MCP adapter (`mcp-server.mjs`) and cockpit UI |
| `lib/` | Truths, discovery, drafting, queue, review, settings and PDF rendering |
| `db/migrations` | Checksummed migrations; never edit one that has shipped |
| `docs/` | [Jobdesk design](docs/local-jobdesk.md) and [MCP tools](docs/jobs-mcp-api.md) |

CI runs every check on macOS, Windows and Linux.

## Provenance

Split out of [Arcadesys/work-thearcades-me](https://github.com/Arcadesys/work-thearcades-me)
on 2026-10-13 with filtered history; PR numbers in older commit messages refer
to that repository. The tag `hosted-final` marks the last version with the
retired hosted cockpit (Next.js, Neon and GitHub sign-in).
