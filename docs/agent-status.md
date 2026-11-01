# Agent status dashboard — corrective milestone (2)

Updated by the coordinator. Per-agent detail lives in `docs/agent-status/<agent>-<assignment>.md`; only that agent writes its own file. No credentials, private messages or internal reasoning are recorded here.

| Agent / lane | Assignment | Owned files | Stage | Last action (evidence) | Current / next | Blocker |
|---|---|---|---|---|---|---|
| coordinator (acting as RED-test lead + implementer) | Reproduce findings 1–6 with failing behavioral tests, then fix | tests/integration/production-reconcile.test.ts, production-bridge.test.ts, storage-durability.test.ts, tests/helpers/appsscript-fakes.ts; then src/app/service.ts, src/app/entrypoints.ts | testing → RED COMPLETE | All 6 findings RED at defect sites (F1 10/12 posts; F2 wrong-rule destination; F5 no DELETE; F3 manual token on scheduled write; F6 0 classroom requests; F4 insert without pending row). Storage pins 3/3 green. Harness gaps fixed: SpreadsheetApp.flush, Utilities.DigestAlgorithm, test isolation (stale connection:* consumed the 3-page budget → stopped='round') | Committing RED suite; then fixes F3/F6 (entrypoints) and F1/F2/F5/F4 (service.ts) | none |
| integration-engineer | (assigned RED phase) | — | **dispatch cancelled 2× by the harness before start** — work moved to coordinator lane; specialist reserved for review lanes | 2 cancellation notices | Review lane later | harness instability on Agent launches |
| integration-engineer | (assigned RED phase) | — | **dispatch cancelled 2× by the harness before start** — work moved to coordinator lane; specialist reserved for review/fix lanes | 2 cancellation notices | Re-dispatch only for bounded later phases | harness instability on Agent launches |
| database-migration-specialist | F4 storage audit + durability contract | src/storage/sheets-store.ts (if needed), docs/agent-status/… | pending | — | After RED lands | none |
| backend-engineer | F3 workflow-aware calendar port + F6 capability bridge | src/app/entrypoints.ts, src/app/sync-bridge.ts (new, optional) | pending | — | After RED lands | none |
| quality-analyst | Verify corrected behavior | read + targeted runs | pending | — | After fixes | none |
| security-privacy-specialist | Grant + durable-operation boundary review | read-only | pending | — | After fixes | none |
| independent-reviewer | Final correction diff review | read-only | pending | — | After QA/security | none |
| gold-final-reviewer | Milestone assessment | read-first | pending | — | Last | none |

Resource note: 15.2 GB RAM total, 2.6 GB free, CPU load 67% at milestone start (6 cores). Policy: one heavy workload at a time; agents run targeted single-file vitest only; the coordinator runs full suites serialized, on Node 24 (`C:/Users/anubh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin`, v24.22.1). PATH node is v22.23.4 — final evidence must be Node 24.
