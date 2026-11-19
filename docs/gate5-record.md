# OrbitDesk Gate 5 live verification

Recorded 19 November 2026. The owner Gmail pilot, automation-off check, and scheduled Calendar write are verified. Full Gate 5 acceptance remains open.

| Check | Result | Live evidence |
| --- | --- | --- |
| Owner Gmail background import | Pass | Version 5 recorded four successful scheduled Gmail imports on 17 November under a Gmail read-only background grant. Calendar reconciliation reported insufficient permissions during that pilot. The earlier test email marker was absent from the inspected results. |
| Automation off | Pass | Version 6 `scheduledSync` was time-driven and completed after starting at 00:08:02 IST on 19 November. Cloud logs showed `status=disabled pages=0 items=0`. The owner Gmail `lastSuccessAt` was `2026-11-16T19:58:10.218Z` before and after the run. |
| Scheduled Calendar write | Pass | Version 6 `scheduledSync` was time-driven and completed after starting at 01:28:02 IST on 19 November. Cloud logs showed `status=ok pages=1 items=5`. Google Calendar showed exactly one **Gate 5 scheduled Calendar test** event on **OrbitDesk test**, from 08:08 to 08:38 IST on 20 November. The event was absent before the run. |

The Calendar run used a separate background grant for `mail.read`, `calendar.list`, `calendar.read`, and `calendar.write`. OrbitDesk Activity recorded one synced event and a separate conflict for a managed event previously deleted in Google Calendar. Automation was turned off and saved after the run.

## Remaining acceptance

- **Secondary-account OAuth is blocked.** After the second account was added to the project's testers, it reached Google consent. The Apps Script callback returned **Page Not Found**. Retrying the callback reproduced the failure, and the Accounts view still showed only the owner account.
- **Live multi-account rotation and budget evidence are pending.** Local scheduler and workflow tests passed. The live checks require a second active read-only background connection.
- **Fresh provider-side revocation is pending.** An earlier run verified behavior with a missing background grant. The remaining check uses a secondary test account with a working background grant, revokes its access, and verifies the next scheduled attempt fails closed.

## Deployment provenance

Version 6 added scheduler result logging to the live Apps Script deployment. The deployed background scope picker and logging source still need to be reconciled with GitHub from the Windows checkout that produced the bundle. This record captures the observed live results.
