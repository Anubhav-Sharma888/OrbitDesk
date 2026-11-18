# OrbitDesk active specification

Updated 18 November 2026. This supersedes Microsoft references in earlier planning documents.

## Foundation and constraints

Build a private, zero-additional-service-cost personal assistant for multiple Gmail/Google Workspace accounts, Google Calendar routing and Google Classroom. Owner: anubhav17826@gmail.com. Google education: anubhav.26ece@bmu.edu.in. Microsoft was removed by the user after institution denial; WhatsApp remains excluded. Account count must be deduplicated; support nine connection slots without claiming nine-account capacity has been measured.

The same saved chats, draft versions, tasks, routing rules and settings must be available on phone and laptop. Offer manual add/edit/dismiss/restore/complete/reschedule, account pause/disconnect, health and activity. Calendar routing supports any authorized source to explicit writable destinations, one master or separate routes. Item overrides outrank highest-priority enabled matching rule, then account default; no arbitrary fallback or accidental fanout.

Import bounded Gmail changes and published student Classroom work. Keep missing or ambiguous email times unknown. Classroom due components are UTC. Exact coursework references merge notifications; similar titles do not. Personal completion never submits coursework. Track official deadlines separately from personal planned times. Only mutate verified OrbitDesk-owned calendar entries; no invitations.

Replies require the user's content and explicit send instruction bound to the exact draft version, recipients, account and thread. AI may propose/rephrase but cannot authorize actions. Unknown send outcomes must not automatically resend. AI is disabled without explicit data-processing consent and a supplied, eligible free API key. No paid fallback.

Use Apps Script V8, private Sheets for app-owned records, restricted Script Properties for credentials, explicit per-account OAuth2, TypeScript, responsive HTML/CSS. Fail closed for unauthorized RPC calls. Never export or return tokens, secrets or passwords, and never mirror whole mailboxes. Render untrusted strings literally. A local demo must be labeled and use the same domain/RPC contract with sample data, without pretending live integrations work.

The user requests all independent implementation, tests and review now. Defer consent, missing credentials, actual deployment authorization, live Google tests, physical phone testing and 48-72-hour live observation to the human checklist. No live email sends, calendar mutations, billing activation or external AI processing during unattended development. Code-ready is distinct from connected/deployed/live-validated.

## First daily-use release

OrbitDesk should reduce the time spent reviewing Gmail and Classroom by flagging actionable items and putting important dates and reminders on Google Calendar. The first rollout focuses on organizing work. In-app reply drafting and explicitly approved sending belong to the later action workflow. Optional AI rephrasing retains its separate approval.

### Triage and sync visibility

- Flag items that need a response or action and important dates such as exams, interviews, meetings and library returns or renewals. Show a short reason on each flag.
- Put ambiguous messages in review before creating an active task or requesting a calendar write. Keep the source available for review.
- Reuse the saved reminder schedule when a category matches clearly. For an unclear or new category, ask the owner to choose an existing category or create one. Let the owner save a word or phrase from the item to help match future notices. Wait for the category decision before scheduling reminders. A clearly actionable item with an unambiguous date can still follow its enabled calendar route while its category is pending.
- When a Gmail sync fails or runs late, show the affected account's last successful Gmail check and warn that recent mail may be missing. The freshness indicator must reflect an actual Gmail check. An execution that skipped the Gmail provider does not refresh it.

### Dates and Calendar behavior

- Automatically add clearly dated, eligible items through the existing routing precedence when the owner has enabled calendar writes for the source and destination. Scheduled calendar mutations require separately authorized background Calendar permissions and live validation. The [Gate 5 read-only Gmail pilot](tomorrow-checklist.md#gate-5--background-scheduling-validation-last-automation-gate) covers Gmail background import.
- Use the source date and time when both are clear. When the source gives a clear date only, use 8 PM IST for the Calendar entry and label it **8 PM IST default · source time unspecified** in OrbitDesk and on Calendar. Keep the official source time unknown and the calendar placeholder and any personal plan in separate fields. Send absent or ambiguous dates to review.
- Offer a manual **Add to Calendar** action when automatic placement fails. Retry through the same ownership and event mapping checks so an earlier write whose outcome was uncertain cannot create a duplicate.
- When an existing Google Calendar event can be verified as the same event, link to it and put OrbitDesk alerts on the dedicated reminders calendar. Keep the linked event read-only.
- When a clearly linked source update reschedules or cancels an item, update or remove the OrbitDesk-owned event and its future reminders and show the change in OrbitDesk. Keep personal plans distinct. Send uncertain matches to review. If the owner deletes an OrbitDesk-managed event directly in Google Calendar, keep the deletion conflict for review and avoid silently recreating the event.

### Saved reminder schedules

| Category | Default reminder times in IST |
| --- | --- |
| Assignment | 9 AM and 9 PM the day before and on the due date |
| Book return | 8 AM and 6 PM the day before and on the due date |
| Exam or evaluation | 8 AM and 8 PM on each of the seven days before the event, ending at 8 PM the evening before |
| Interview | 8 PM the day before and 8 AM on the event date |
| Meeting | 8 PM the day before and 8 AM on the event date |

Move reminders at or after the scheduled event or deadline to one hour before when that time is still in the future. If the adjusted time has passed, skip that reminder. Collapse adjustments that produce the same notification time for the same item into one. Keep one main exam entry and use a dedicated reminders calendar for the extra alerts needed to deliver the 14-reminder pattern. Reconcile those reminder entries with the same source item.

### Rollout and acceptance

Finish the live background Gmail pilot, then implement and validate triage, calendar placement, reminders and their failure paths before the daily-use trial. Start the trial with Gmail and Calendar if BMU Classroom access is pending. The trial duration is open and will be decided later. Measure time spent reviewing incoming work, including follow-up checks in Gmail or Classroom, against the usual workflow. Keep the target of at least 25% less review time. A missed clearly stated exam, interview or submission deadline calls for a fix and retest before expanding into the reply workflow.

The 48–72-hour technical observation remains in the release checklist for operational reliability. The product trial measures whether the workflow saves review time.
