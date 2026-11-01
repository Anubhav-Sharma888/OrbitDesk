# OrbitDesk - steps that need you

No password, verification code or client secret should be pasted into chat.

- Complete Google account consent for the owner and Google education account, after reviewing the exact requested scopes. Additional Gmail identities are not yet inventoried or authorized.
- Verify the two OAuth test users saved successfully; add the other Gmail addresses when supplied. Testing-mode Google refresh tokens for mailbox scopes normally expire after seven days; review the personal-use production configuration after access proof.
- Approve/authorize private owner-only Apps Script deployment and its dedicated storage permissions. The script and unbilled Cloud project already exist; the client credentials are in private script properties.
- Verify the education institution permits Gmail/Classroom API access and the enrolled student courses can be read. Respect any denial.
- Select a dedicated test calendar and approved sample messages. Confirm writable calendar roles and cross-account routing. No live calendar changes or email sends were made during unattended development. After deployment, first exercise the reconcile stage against only that dedicated test calendar (one rule, one destination) before enabling any broader route; calendar event lifecycle (create/update/cleanup on complete-dismiss-ignore/route-change, restoration) now runs after completed syncs for explicitly configured destinations, and scheduled-context calendar writes use the background grant exclusively — validate exactly that path (including a deliberately missing background grant failing closed) during the dedicated-calendar exercise.
- If AI is desired, supply an eligible free API key directly in private script settings, review data-processing/retention choices and enable consent explicitly. Structured sync/manual controls work without AI.
- Validate the deployed application on an actual phone and laptop and observe scheduled operation for 48-72 hours. Automated/demo tests do not replace these checks.

Microsoft and WhatsApp require no action for this release; both are excluded.
