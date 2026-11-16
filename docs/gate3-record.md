## Gate 3 VERIFIED — dedicated-calendar lifecycle + restore path (2026-11-15)

**Deployment:** Apps Script **Version 3** (Code.gs SHA-256 `8BAB19DC1756EF0ED579C657CD595941994A8A89CFDEB551EA96DBF25A664DC4`); local verification Node v24.22.1 — clean typecheck, **147/147 tests (15 files)**, build pass.

**Live lifecycle on the disposable "OrbitDesk test" calendar (owner-observed):**
- Recovery Sync → managed event created ("1 events, 1 synced, 0 conflicts, 0 needing attention, 0 skipped" — Nov 15, 12:54 PM IST).
- Route change: the owner's first override had selected the **primary calendar** (Google names primary calendars with the account email) — the app **moved the event off it safely** when the destination was corrected to OrbitDesk test.
- Complete + Sync → event **removed** (0). Dismiss → Restore + Sync → event **recreated** (1). Repeat Sync after the 15-second manual interval → still 1 (idempotent, no duplicates).
- The test task remains open and routed to OrbitDesk test.

**Two defects found and fixed in this gate, both regression-tested:**
1. **Restore-path (trash reservation):** at Version 2, Restore + Sync produced `1 conflicts — "The managed calendar event was deleted elsewhere"` — Google keeps deleted events GET-able as `cancelled`, and the reconcile refused to recreate OrbitDesk's own trashed event. The Version 3 fix allowed restore-in-place when the **link row was absent** (OrbitDesk's own delete; the owner's Restore is the explicit intent), ownership is re-verified on the trashed event, and the recreate uses `CalendarPort.restore` (PATCH with `status:'confirmed'` per the Calendar API's restore semantics). A **second defect** the review caught: `parseEvent` stripped `extendedProperties` from cancelled events, so ownership could never be re-verified on the live port — fixed, with the real-adapter regression `cancelledEventParseKeepsOwnershipMetadataSoRestoreCanVerifyIt`. Version 3 used this condition: **cancelled + link row absent = restorable (OrbitDesk's own delete); cancelled + link row present = external deletion → stays a conflict** (`manualUserDeletionOfAnOpenTaskEventStaysInConflict`).
2. **Sheets date-coercion:** the first Sync failed closed with `STORAGE_CORRUPT` — Google Sheets coerced the `sync_budgets` date-key id `2026-11-14` to serial `46340` at write time. Fixed with a write-path guard (bare `YYYY-MM-DD` cells apostrophe-protected) and modeled in the test fakes.

**Tracked UI gap (separate item):** the Completed task state has **no direct Reopen/Restore control** — the live workaround was Dismiss → Restore. Tracked for the next milestone.

**Boundaries:** lifecycle ran only against the disposable "OrbitDesk test" calendar; no sends, no Classroom, no background scheduling, no AI, automation switch untouched, billing untouched. PR #1 was merged to main at `d3a9027`; PR #3 merged Gates 2–3 into `main` at `f536f68`. Gate 3 proves the calendar write/lifecycle path live; it does not validate Gmail imports (the bounded read ran separately), sends, or scheduling.

### Version 4 follow-up — verified 17 November 2026 (IST)

- OrbitDesk's own deletion restored the same event on the dedicated **OrbitDesk test** calendar: Complete → Sync → Dismiss → Restore → Sync produced **1 → 0 → 1**. At 00:12 IST the reconcile row showed 0 events and 1 synced. At 00:13 IST it showed 1 event and 1 synced. Both showed zero conflicts.
- A direct deletion in Google Calendar stayed deleted through completion and reopening. The 00:15, 00:16, and 00:17 IST runs each showed 0 events and reported “The managed calendar event was deleted elsewhere.” The task was left open, routed to OrbitDesk test, and the event was verified in Google Calendar's Bin.
- Commit `62dd1ff` requires confirmed OrbitDesk deletion before restoration, preserves the link on external deletion, and guards duplicate-ID recovery. Typecheck, 150 tests across 15 files, and the build passed. The Windows `Code.gs` hash matched the independently built artifact (`943616EA6DE0E4FE81A3AF3061BB76D9B4BABEBE1CEC0CECEBE1BDAC27099E6A`). The live app loaded and Version 4 was verified directly. The deployed artifact's hash was not independently verified.
