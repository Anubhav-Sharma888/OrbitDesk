# OrbitDesk QA report — 2026-11-01

Scope: development branch `develop`. The first milestone's evidence (below) was recorded at `40621a3`/`629e34a`; the corrective milestone's evidence follows in its own section. **This is a code-ready verification, not a release, deployment or security certification, and not live Google validation.**

## Corrective milestone (2) — production-integration defects, 2026-11-01

Six production-integration findings were investigated against current code, each reproduced with a failing behavioral test (RED) before fixing, on top of PR #1's branch (RED suite committed as `33a40fc`):

1. **Fair reconciliation** — the bounded pass re-sliced the same oldest ten every pass; the last two of twelve were deferred forever. Fixed with a durable rotation cursor (`reconcile_cursor`): each pass starts after the task the previous pass processed last. Regression: `fairRotationEventuallyConsidersEveryTask` (12 tasks → 10 posts, then 12, restart-safe) and `reconcilePassIsBoundedAndRotatesFairly` (updated from the starvation-pinning test).
2. **Routing consistency** — the reconcile pass called `decideRoute` WITHOUT source records, so sender rules never matched and keyword rules matched on titles/notes only — the reproduced failure wrote the event to the WRONG rule's destination. Fixed: execution now passes the same account-scoped `sources` context as routing preview. Regression: `executionRoutingMatchesPreviewIncludingSources`.
3. **Background grant isolation** — `liveService(owner,'agent')` built `GoogleCalendar` on the MANUAL transport, so scheduled calendar operations used the manual grant and, without any background grant, still wrote. Fixed: the calendar port follows the selected workflow; `OAuthBroker.access` fails closed (BACKGROUND_GRANT_REQUIRED) with no fallback. Reproduced in production wiring (real `scheduledSync` over fakes): `scheduledReconcileUsesBackgroundGrant`, `missingBackgroundGrantFailsClosed`.
4. **Durable remote-operation boundary** — the whole reconcile pass ran inside one `store.atomic`; SheetRecordStore buffers nested writes until the outer commit, so pending-operation rows were NOT durable at provider-call time (reproduced: insert fired with no pending row in the simulated Sheet). Fixed: coordination moved to a durable lease separate from storage transactions; each pending op commits before its provider call and its outcome after. Recovery tests: `pendingOperationIsDurableBeforeProviderCall`, `interruptionRecoveryWithoutDuplicateEvents`; storage semantics pinned by `storage-durability.test.ts` (buffered outer transactions, immediate top-level durability, rollback of read-only imports leaves no partial rows). The import/scheduler round-level transaction is documented as safe: imports are read-only remote operations, so rollback cannot undo a remote effect; sends already commit their pending state before the provider call.
5. **Managed-event lifecycle** — the production pass filtered to open tasks and skipped non-automatic decisions, making the reconciler's cleanup paths unreachable (reproduced: no deletion after complete/dismiss/ignore, no recreation after restore). Fixed: candidates are open tasks plus any task that still owns calendar links whose decision is not review; the reconciler handles automatic keep-in-step, obsolete-mapping cleanup, restoration and destination moves. Regression: `managedEventLifecycleTransitions` (complete/dismiss/restore/ignore/route-change/review-pause).
6. **Capability-aware import bridge** — the bridge attempted Gmail before Classroom for every connection (reproduced: a Classroom-only account made zero Classroom requests; a Gmail-only account's page failed after its Gmail work succeeded). Fixed: providers are selected from the connection's effective capabilities in the selected workflow; combined accounts get bounded fair progress (each provider ≥1 and ≤half the page allowance per page). Regression: `importBridgeSelectsProvidersByCapability` (all three capability combinations).

Corrective-milestone verification (all run fresh on Node v24.22.1, the documented >=24 engine, serialized):

| Check | Command | Result |
|---|---|---|
| TypeScript | `npm run typecheck` | 0 errors |
| Core/contract/integration | `npm test` | **135 passed / 135** (14 files; 0 skipped) |
| Build | `npm run build` | pass |
| Browser (in-page harness) | `npm run test:browser` | **14 passed / 14** |
| Browser (backend-driven) | flagged demo server + `ORBITDESK_BASE_URL` | **13 passed, 1 skipped** — the AI-rephrase test skips because the demo backend keeps AI fail-closed (no key); documented, not faked |

Review trail for this milestone: quality-analyst verification, security-privacy review (grant and durable-operation boundaries), independent whole-diff review and the gold final assessment are recorded below once complete.

---

# First milestone (1) — application integration, 2026-11-01

Scope: development branch `develop` at commit `40621a3` (session 2026-11-01). All checks were run on this commit by the coordinator and by an independent quality analyst on `0b0e402` (identical suites, smaller counts before the last two fix batches).

## Verification results (exact)

| Check | Command | Result |
|---|---|---|
| TypeScript | `npm run typecheck` | 0 errors |
| Core / contract / integration | `npm test` | **124 passed / 124** (11 files; 0 skipped) |
| Build | `npm run build` | pass — Apps Script IIFE + ESM twin + browser assets, "no credentials included" |
| Browser, in-page contract harness | `npm run test:browser` | **14 passed / 14** |
| Browser, backend-driven | `ORBITDESK_DEMO_ALLOW_RESET=1 node tests/browser/demo-server.mjs` + `ORBITDESK_BASE_URL=http://127.0.0.1:4174 npm run test:browser` | **13 passed, 1 skipped** — the AI-rephrase test skips by design: the demo backend keeps AI fail-closed (no key), so the flow is exercised in mock mode only |
| Node | — | v22.23.4 (package.json requests >=24; npm does not enforce engines). Everything passed on Node 22, including the Playwright webServer (`process.execPath`) |

Demo curl evidence (server with `ORBITDESK_DEMO_ALLOW_RESET=1`, separate connections):
- `state.get` → `mode:'demo'`, sample rows labelled "(sample)".
- Cross-connection continuity: task created on connection 1 visible from connection 2.
- `sync.now` → `ok` (2 pages, 4 items) with per-account `lastSync`; immediate second call → `throttled` (durable 15 s manual interval).
- Imported draft: send → `REVIEW_REQUIRED`; save clears the flag; send succeeds via the simulated port.
- `route.preview` to a read-only calendar → `ok:true` with `errors:["The selected calendar is unavailable or does not grant supported write access"]`.
- Malformed JSON → 400; >10 MB body → 413; unknown command → `UNKNOWN_COMMAND` with state; reset/seed endpoints → 404 without the flag; demo server rejects cross-origin POSTs (403).
- Calendar reconcile stage: automatic-route tasks produce managed events through the simulated full calendar port (deterministic `od…` ids, ownership extended properties); review/ignore and imported-unreviewed never write; etag conflicts are contained in the activity summary; >10 eligible tasks defer the tail.

## Review trail

1. **Product-requirements analyst** (read-only): 10 material gaps; 8 closed in this session, 2 ruled (agenda folded into Tasks; conflict-alert UX accepted). Gaps and rulings are recorded in [development-ledger.md](development-ledger.md).
2. **Quality analyst** (independent, on `0b0e402`): verified every suite in both browser modes plus curl edge cases; no skipped tests; no secret-shaped fields in state responses; verdict "verified at the code-ready level". Two bookkeeping items (qa-report missing, disconnect test naming) — both closed since.
3. **Security-privacy specialist** (independent, on `0b0e402`): no critical/high findings; 4 low findings + info notes, **all fixed with regression tests** in commit `a28c280` (login_hint binding, corrupt-pending and corrupt-connection row tolerance, portless outbound URLs, mkdtemp demo bundle, rephrase notice display, hook-state removal, demo CSRF guard).
4. **Independent whole-project reviewer** (on `a28c280`): verdict "REQUEST CHANGES (narrow)" with 1 high + 1 medium + 10 low findings. **All addressed in commit `40621a3`**: the high finding (CalendarReconciler had no production caller — calendar routing never produced events end-to-end) is fixed by a bounded post-sync reconcile stage with 7 regression tests; the medium finding (missing qa-report.md) is this document; low findings were fixed or documented (see ledger).
5. **Gold final review** (on `629e34a`): independently reproduced the full evidence chain (typecheck, 124/124 core, build, 14/14 browser default, 13+1-skip backend-driven, its own curl battery incl. guarded endpoints and cross-origin rejection) and audited the A/B/C readiness claims against the code. **Verdict: ACCEPT WITH MINOR FINDINGS** — no code change required. Findings and disposition: D1 (the ledger's push/PR line was recorded before the push; remedied by actually pushing `develop` and opening the PR this session), N1 (stale Node/webServer note — fixed), N2 ("all findings fixed" → "fixed or documented" — fixed), N3 (unnecessary-but-harmless webServer flag — left, documented). One live-checklist observation: in a trigger context the reconcile stage's calendar writes go through the manual-grant transport while import pages use the agent grant — the dedicated-test-calendar step must validate this path explicitly (noted in tomorrow-checklist.md).

## What this evidence does NOT establish

- No live Google OAuth grant, Gmail send, calendar write, Classroom read, or Groq call was performed — all provider ports in local runs are simulations and the demo backend is fail-closed (`account.connect` → `SETUP_REQUIRED`).
- No deployment, no trigger installation, no billing activation, no paid fallback. Automation is off by default; the reconcile stage only ever acts on owner-configured destinations.
- No real cross-device sync: the demo demonstrates the continuity shape (one shared store, two browser sessions).
- "Send succeeds" is service-level success against a simulated port — provider acceptance and recipient delivery remain unproven until the live checklist passes.
