## Gate 3 VERIFIED — dedicated-calendar lifecycle + restore path (2026-11-15)

**Deployment:** Apps Script **Version 3** (Code.gs SHA-256 `8BAB19DC1756EF0ED579C657CD595941994A8A89CFDEB551EA96DBF25A664DC4`); local verification Node v24.22.1 — clean typecheck, **147/147 tests (15 files)**, build pass.

**Live lifecycle on the disposable "OrbitDesk test" calendar (owner-observed):**
- Recovery Sync → managed event created ("1 events, 1 synced, 0 conflicts, 0 needing attention, 0 skipped" — Nov 15, 12:54 PM IST).
- Route change: the owner's first override had selected the **primary calendar** (Google names primary calendars with the account email) — the app **moved the event off it safely** when the destination was corrected to OrbitDesk test.
- Complete + Sync → event **removed** (0). Dismiss → Restore + Sync → event **recreated** (1). Repeat Sync after the 15-second manual interval → still 1 (idempotent, no duplicates).
- The test task remains open and routed to OrbitDesk test.

**Two defects found and fixed in this gate, both regression-tested:**
1. **Restore-path (trash reservation):** at Version 2, Restore + Sync produced `1 conflicts — "The managed calendar event was deleted elsewhere"` — Google keeps deleted events GET-able as `cancelled`, and the reconcile refused to recreate OrbitDesk's own trashed event. Fixed: restore-in-place fires only when the **link row is absent** (OrbitDesk's own delete; the owner's Restore is the explicit intent), ownership is re-verified on the trashed event, and the recreate uses `CalendarPort.restore` (PATCH with `status:'confirmed'` per the Calendar API's restore semantics). A **second defect** the review caught: `parseEvent` stripped `extendedProperties` from cancelled events, so ownership could never be re-verified on the live port — fixed, with the real-adapter regression `cancelledEventParseKeepsOwnershipMetadataSoRestoreCanVerifyIt`. The distinguishing condition: **cancelled + link row absent = restorable (OrbitDesk's own delete); cancelled + link row present = external deletion → stays a conflict** (`manualUserDeletionOfAnOpenTaskEventStaysInConflict`).
2. **Sheets date-coercion:** the first Sync failed closed with `STORAGE_CORRUPT` — Google Sheets coerced the `sync_budgets` date-key id `2026-11-14` to serial `46340` at write time. Fixed with a write-path guard (bare `YYYY-MM-DD` cells apostrophe-protected) and modeled in the test fakes.

**Tracked UI gap (separate item):** the Completed task state has **no direct Reopen/Restore control** — the live workaround was Dismiss → Restore. Tracked for the next milestone.

**Boundaries:** lifecycle ran only against the disposable "OrbitDesk test" calendar; no sends, no Classroom, no background scheduling, no AI, automation switch untouched, billing untouched, PR #1 unmerged. Gate 3 proves the calendar write/lifecycle path live; it does not validate Gmail imports (the bounded read ran separately), sends, or scheduling.
