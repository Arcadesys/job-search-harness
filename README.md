# job-search-harness

A private job-search workspace where AI can draft but cannot invent. It finds
leads, drafts tailored applications from reviewed résumé claims, and hands
batches to an MCP worker. Nothing counts as submitted without a saved
confirmation.

The design is written up at
[work.thearcades.me/work/job-search-cockpit](https://work.thearcades.me/work/job-search-cockpit).

## Layout

| Path | What it is |
| --- | --- |
| `app/jobs`, `app/api/jobs` | Hosted cockpit (Next.js) behind GitHub OAuth (`auth.ts`) |
| `services/jobdesk` | Local PGlite jobdesk: owner service, CLI, and stdio MCP adapter |
| `lib/` | Discovery, fit scoring, drafting, queue, résumé truths, PDF rendering |
| `db/migrations` | Checksummed SQL migrations shared by the hosted and local stores |
| `docs/` | MCP API contract, local jobdesk design and validation, foundation notes |

## Run

```sh
npm install
npm test                 # lib unit tests
npm run test:jobdesk     # local jobdesk service tests
npm run build            # hosted cockpit
npm run jobs:start       # local jobdesk owner (see docs/local-jobdesk.md)
```

Browser suites: `npm run test:jobdesk:browser` and `npm run test:truths`
(run `npx playwright install chromium` first).

Hosted configuration is listed in `.env.example`.

## Provenance

Split out of [Arcadesys/work-thearcades-me](https://github.com/Arcadesys/work-thearcades-me)
on 2026-10-13 with filtered history, so `git log` covers every harness commit
from the original repo. PR numbers in older commit messages refer to that
repository.

`lib/resume-truth-seeds.json` is a frozen snapshot of the portfolio résumé
exports as of the split. The positional claim IDs are load-bearing, so the
snapshot does not track later résumé edits; review and edit claims in the
Truths view instead.

## Cutover status

Staged. The live cockpit still runs from the portfolio's Vercel project at
`work.thearcades.me/jobs`, and the installed job-hunt plugin still points
there. Until this repo has its own deployment, OAuth callback, and repointed
plugin, the copy in the portfolio repo remains the production one.
