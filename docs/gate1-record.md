## Gate 1 VERIFIED — owner-only deployment + private storage (2026-11-15)

Owner-performed guided sequence, all evidence owner-observed:

- **Deployment:** Apps Script project "OrbitDesk" (`16gurcJgk7TdSw5d1G_HCpXbzNv62Nw0gOU5Q1HdqiOipLgQrLsu5QCFl`) — **Version 1, created 15 Nov 2026, 01:29**, web app Execute as Me / access Only myself. Never deployed before this gate.
- **Files:** the three hash-verified build artifacts pasted into the project (Code.gs, Index.html, appsscript.json manifest).
- **Configuration:** all four required Script Properties verified present by name (`OWNER_EMAIL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `STORAGE_SPREADSHEET_ID` — values never displayed). New private Sheet "OrbitDesk storage" created; its ID configured as the storage location.
- **OAuth:** the consent-screen test-users list was found empty (initial 403 access_denied explained); the owner account was added as a test user (publishing status remains Testing — not published to production). Granted scopes verified by the owner at myaccount.google.com/permissions: **exactly `userinfo.email`, `spreadsheets`, `script.external_request`** — no Gmail, Calendar, Classroom or unexpected permissions.
- **Persistence proof:** the deployed app loaded cleanly at the private /exec URL (no error banners); two independent smoke tests — conversation "ABC" with message "hi", and "Gate 1 smoke test" with "storage verification record" — each survived a hard F5 reload, proving app-owned records persist in the private storage Sheet.

**Status: GATE 1 VERIFIED.** Boundaries honored: no Gmail/Calendar/Classroom grant, no sends, no calendar mutations, no background OAuth client, no triggers, no AI properties, automation off, billing untouched, PR #1 unmerged. Deployment success does not validate live mail/calendar/Classroom integrations — Gates 2–5 do.

Next gate: Gate 2 — read-only account validation (connect the owner account with read-only capabilities only; education account separately, respecting BMU policy). Details: docs/tomorrow-checklist.md.
