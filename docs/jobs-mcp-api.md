# Local job-hunt MCP API

This private API is the narrow data interface for the local stdio MCP client. It never submits an application to an employer. Every route requires `Authorization: Bearer <token>`, rechecks the token expiry and revocation state, verifies that its owner is still in `JOBS_GITHUB_ACCOUNT_IDS`, enforces owner-scoped batch membership, and returns `Cache-Control: private, no-store`.

Tokens are created and revoked in the GitHub-allowlisted `/jobs/settings` page. A new token expires after 90 days, is stored only as a SHA-256 hash, and is returned to the browser once. Copy it to the local Mac Keychain flow; never put it in project files or logs.

## Endpoints

- `GET /api/jobs/mcp/batches` returns `{ selectedBatchId, batches }`. Every batch has `id`, `isSelected`, `createdAt`, `itemCount`, and counts for each item state. The selected batch is returned even when it is older than the 50-batch history window.
- `GET /api/jobs/mcp/batches/{batchId}/items` returns the owner's items with lead title, organization, location, source URL, verification state, and queue status.
- `GET /api/jobs/mcp/items/{itemId}` returns the owner's lead, the saved résumé/outreach draft when present, and reviewed résumé truths.
- `PATCH /api/jobs/mcp/items/{itemId}` accepts `{ "status": "queued|preparing|awaiting_approval|blocked|skipped", "note"?: "..." }`. The API does not accept `submitted` through this route.
- `POST /api/jobs/mcp/items/{itemId}/submission` accepts `{ "idempotencyKey": "...", "confirmation": "...", "confirmationUrl"?: "https://..." }`. It saves one receipt per item, marks the item submitted, changes the lead stage to applied, and adds a weekly application event in the same database statement. Retrying with the same key returns the same receipt; a different receipt for the item is rejected.

The `confirmation` is the worker's report of the confirmation shown in the employer's browser after submission. The server cannot independently verify the employer's system. The MCP worker must inspect that browser confirmation before calling this endpoint. Weekly application counts use these saved receipts only; historical manually entered application events remain stored but are not counted as confirmed submissions. There is no ATS submit endpoint.

Responses are JSON. Invalid input returns 400, missing/invalid/expired/revoked credentials return 401, owner-inaccessible records return 404, and storage or idempotency conflicts return 409 or 503 as applicable.
