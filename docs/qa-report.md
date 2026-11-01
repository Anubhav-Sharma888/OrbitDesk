# OrbitDesk QA report — 2026-11-01

Scope: development branch `develop` at commit `40621a3` (session 2026-11-01). All checks were run on this commit by the coordinator and by an independent quality analyst on `0b0e402` (identical suites, smaller counts before the last two fix batches). **This is a code-ready verification, not a release, deployment or security certification, and not live Google validation.**

## Verification results (exact)

| Check | Command | Result |
|---|---|---|
| TypeScript | `npm run typecheck` | 0 errors |
| Core / contract / integration | `npm test` | **124 passed / 124** (11 files; 0 skipped) |
| Build | `npm run build` | pass — Apps Script IIFE + ESM twin + browser assets, "no credentials included" |
| Browser, in-page contract harness | `npm run test:browser` | **14 passed / 14** |
| Browser, backend-driven | `ORBITDESK_DEMO_ALLOW_RESET=1 node tests/browser/demo-server.mjs` + `ORBITDESK_BASE_URL=http://127.0.0.1:4174 npm run test:browser` | **13 passed, 1 skipped** — the AI-rephrase test skips by design: the demo backend keeps AI fail-closed (no key), so the flow is exercised in mock mode only |
| Node | — | v22.23.4 (package.json requests >=24; npm does not enforce engines). Everything passed on Node 22; Node 24 binary is used by the Playwright webServer |

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
5. **Gold final review**: pending at the time of writing; its verdict and any fixes will be appended below by the coordinator.

## What this evidence does NOT establish

- No live Google OAuth grant, Gmail send, calendar write, Classroom read, or Groq call was performed — all provider ports in local runs are simulations and the demo backend is fail-closed (`account.connect` → `SETUP_REQUIRED`).
- No deployment, no trigger installation, no billing activation, no paid fallback. Automation is off by default; the reconcile stage only ever acts on owner-configured destinations.
- No real cross-device sync: the demo demonstrates the continuity shape (one shared store, two browser sessions).
- "Send succeeds" is service-level success against a simulated port — provider acceptance and recipient delivery remain unproven until the live checklist passes.
