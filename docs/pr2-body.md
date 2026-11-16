## Gates 2–3: live verification + production fixes (develop → main)

Follow-up to PR #1 (merged at `d3a9027`). Carries the post-merge work on `develop` into `main`: Gate 2–3 live-verification records, the production fixes those gates surfaced, and the documentation corrections from the supervising review. **Tested commit: `80bcdff`** (plus the doc corrections landing on top).

## Production fixes (each regression-tested, RED-first where found)

1. **Restore-path trash reservation** — Google Calendar keeps deleted events GET-able as `cancelled`; the reconcile refused to recreate OrbitDesk's own trashed event, so Restore could never recreate. Fixed: restore-in-place via `CalendarPort.restore` (PATCH with `status:'confirmed'` per the Calendar API's restore semantics), gated on the link row being absent (OrbitDesk's own delete vs an external/user deletion — the latter stays a conflict). `parseEvent` now preserves ownership/attendees/conference/recurrence metadata on cancelled events (a review-caught HIGH: the live restore arm could never verify ownership without it). Regression: `cancelledEventParseKeepsOwnershipMetadataSoRestoreCanVerifyIt` (real adapter), `manualUserDeletionOfAnOpenTaskEventStaysInConflict`, trash-modeled lifecycle.
2. **Sheets date-coercion guard** — Google Sheets coerced the `sync_budgets` date-key id `2026-11-14` to serial `46340` at write time (first live `STORAGE_CORRUPT`, fail-closed as designed). Fixed: bare `YYYY-MM-DD` write cells are apostrophe-protected; reads return clean strings. Regression: `dateLikeIdsSurviveGoogleSheetsCoercion` with a coercion-modeling fake.
3. **Supersession fencing** — a stale reconcile worker whose lease expired mid-pass could resurrect merge-removed events. Fixed: per-task lease re-check; superseded passes record honestly and leave the cursor to the current holder. Regression: `lease-supersession.test.ts` (both storage backends).

## Live verification (owner-observed, documented in docs/qa-report.md)

- **Gate 1:** owner-only deployment (Version 1), private storage Sheet, storage persistence proven twice.
- **Gate 2:** read-only Gmail connection (`active`, `mail · read` only).
- **Gate 3 (Version 3):** full managed-event lifecycle live on the disposable "OrbitDesk test" calendar — create, route-change move, complete→removed, dismiss→removed, restore→recreated, repeat-sync idempotent. Reconcile row verbatim: "1 events, 1 synced, 0 conflicts, 0 needing attention, 0 skipped" (Nov 15, 12:54 PM IST).

## Verification

- Node v24.22.1 (documented engine); typecheck clean; **147/147 core tests (15 files, 0 skipped)**; build pass; browser 14/14 default + 13+1 documented skip backend-driven; isolated clean-install reproducibility verified (Gate 0).
- Review trail: quality-analyst (code-ready verified; found the parseEvent gap pre-deploy), security-privacy (grant/durability boundaries PASS), independent (ACCEPT WITH MINOR FINDINGS, all applied), gold final (ACCEPT WITH MINOR FINDINGS), devops (deployment candidate ACCEPT).

## Non-claims

Gates verified live so far: deployment, storage, calendar lifecycle (disposable calendar only), read-only Gmail connection. **Not validated:** Gmail import beyond the bounded read, sends, background scheduling, AI, real cross-device sync, 48–72h observation. No billing, no triggers installed, automation off. Microsoft and WhatsApp excluded.
