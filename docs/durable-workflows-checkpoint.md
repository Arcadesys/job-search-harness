# Durable workflows checkpoint

Tracking: https://github.com/Arcadesys/job-search-harness/issues/3

Route: workhorse / medium, as requested. The coordinating desktop chat cannot switch its model in place; no enforced model switch is claimed. Implementation remains in one context.

Base: c0adb673f02e41c5687c17ac3ebd446bdaa0b852. Isolated branch: codex/durable-workflows.

Current: durable collection, exclusions, compact preparation, explicit revisions, material exports, and local installation transition implemented. The legacy checkout/data and rollback configuration are retained separately. Private verification reports are outside this repository.

Evidence: fixed fictional fixture preparation packets decreased from 14,685 to 6,583 UTF-8 bytes (55%); the comparison including extra evidence retrieval also clears 50%. Token counts, provider billing savings, and tool-definition startup costs are separate. Tests cover source failures/resume, stale writes, bounded repair, role attribution, revision/reversion cache binding, persistence, old-schema restore, and desktop/mobile rendered accessibility. Installed MCP demonstrated collection, exclusion restoration, separate résumé/review exports, exact configured link checks, and cache persistence after restart. A separate copied-store upgrade compared every original row/field before the installation was reconnected.

Follow-up: the user requested deterministic fuzzing. Added a seeded state-machine corpus, collection fault sequences, source mutations and controlled render interleavings. The interleaving tests exposed and now guard against a superseded render replacing newer work, and a late review reactivating superseded artifacts. Unusable empty titles are rejected. A delayed-animation-frame browser check also reproduced the claim editor's deferred focus race; cancellation now restores focus during the render commit. The reference model checks semantic inputs independently of production hashes. Route remains workhorse / medium in the same context.

Follow-up evidence: 11 seeds and 2,240 workflow actions passed, plus 600 source mutations per seed run and five controlled render interleavings. The default corpus runs in the service suite. Local checks: 35 library tests, 40 service tests plus one platform-specific skip, 25 browser tests, typecheck and lint passed. Backup/restore and restart are exercised on fictional stores, including explicit rejection of corrupt backups. Expanded seeds: 0, 2, 3, 4, 42, 65535, 2147483648 and 4294967295 at 256 steps each; the default three seeds use 64 steps each.

Next: verify CI for the updated head. The preceding head passed Linux, macOS and Windows. Merge remains a separate user decision. A new chat loads the refreshed installed skill and MCP tool definitions. The visible local cockpit was reopened with a fresh ticket and authenticated rendering was verified.

Browser plugin not available; rendered QA uses the repository's Playwright setup.
