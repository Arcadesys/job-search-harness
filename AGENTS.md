# AGENTS.md

## Ground rules

- The workspace is private. Keep every page and API `noindex`, keep
  `Cache-Control: private, no-store` on API responses, and never add analytics.
- Drafts are assembled only from reviewed résumé claims. Do not add paths that
  let a model write claim text that has not been reviewed.
- Nothing is recorded as submitted without a saved confirmation receipt.
- Never edit an applied migration in `db/migrations`; add a new one. The local
  jobdesk rejects checksum drift.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
