# Personal assistant: proposed design

Date: 29 October 2026  
Status: Design for user review. No application has been built or connected to accounts.

## Purpose

Build a private personal assistant for seven to eight initial email accounts, with capacity planning for up to nine if an additional Microsoft business mailbox is included. The user's current inventory is five Gmail accounts, one education mailbox of an unconfirmed provider, one or two Microsoft mailboxes, and possibly one additional Microsoft business mailbox. It brings Gmail, supported school/university mail, Outlook, Google Classroom assignments, and selected Google Calendars into one interface. It automatically tracks clear deadlines and maintains calendar entries under the user's rules. The user can also add, edit, dismiss, restore, and organize items manually.

The same saved conversations, reply drafts, tasks, settings, connections, and routing rules must be available on both phone and laptop. Software, hosting, storage, and AI use must remain on free allowances: no payment methods, paid upgrades, paid domains, paid app-store publication, or expiring trial credits are part of this design. This assumes the user's existing devices, internet access, and mailbox entitlements.

## Requirements supplied by the user

- Personal use only: five Gmail accounts, one education mailbox, one or two Microsoft mailboxes, and possibly one separate Microsoft business mailbox. Seven to eight initially; plan capacity for nine. The education mailbox's hosting provider still needs identification.
- Support multiple Gmail/Google Workspace accounts, including school, college, and university accounts, and Outlook/Microsoft-hosted accounts where access is permitted.
- Connect Google Classroom where the user has access.
- Configure any supported source account to route extracted deadlines/events to any authorized, writable Google Calendar; many sources may use one calendar, and individual sources may use different calendars.
- Maintain conversation and application continuity between mobile and laptop.
- Provide a simple interface with manual controls as well as automation; LifeTrack is a reference for simplicity. The existing LifeTrack app is not modified.
- Send replies only when the user supplies the intended content and instructs the app to send. Rephrasing may improve wording but must preserve meaning.
- Exclude WhatsApp from this version.
- Keep ongoing project service expenditure at zero. Quota exhaustion must never trigger paid fallback.

## Approaches considered and proposed choice

| Approach | Benefits | Costs and limitations |
| --- | --- | --- |
| Android APK plus a hosted backend | Familiar installed app, local caching, Android integration | Still needs a laptop interface and shared backend; adds maintenance without solving the zero-cost backend constraint |
| Private Apps Script web app plus Google storage | One browser interface for both devices, hosted execution, scheduled checks, no separate paid hosting required | Execution quotas, periodic rather than instant background processing, and multiple-account OAuth setup must be proven |
| Full custom web service on other providers' free plans | More flexible database, authentication, and scheduling | More services and secrets to maintain; free-plan eligibility and operational limits would require separate verification |

Proposed choice: a private, responsive Apps Script web app with shared Google storage and separate account authorizations. The user delegated the APK-versus-web decision to the builder and made continuity and zero cost the deciding requirements. Apps Script is the builder's recommendation; it has not yet passed an account-access proof or user design approval.

The interface is initially an online web app with a bookmark/home-screen shortcut. Full PWA installation, dependable offline editing, native widgets, and a standalone APK are not promised in version one.

## Accounts, identity, and supported services

One primary Google account owns the app, its deployment, and private storage. Only that owner may access the app. The seven to eight connected mailboxes remain separate authorizations attached to the owner's profile; they are not seven to eight users of the application.

For every connection, store a stable provider account identifier, display label, verified email address, granted capabilities, connection status, last successful sync, and independent sync cursor. Account labels are editable; authorization never depends on a typed email label alone.

The default Apps Script Gmail helper operates under one execution identity. Multiple accounts require explicit OAuth connections and direct provider API calls. Use the maintained Google Workspace Apps Script OAuth2 library, with isolated storage for each connection and offline access where permitted. Account linking must not switch the central app identity or lose existing connections.

| Provider | Connector and scope |
| --- | --- |
| Gmail / Google Workspace | Gmail API; read messages and send instructed replies from the authorized mailbox |
| Google Classroom | Classroom API; published coursework and the user's permitted submission status, with read-only access initially |
| Google Calendar | Calendar API; list authorized calendars and manage entries in selected writable calendars |
| Outlook.com / Microsoft 365 | Microsoft Graph delegated mail permissions; app registration configured for organizational and personal accounts |
| Other university mail systems | Not automatically supported by the address suffix. Identify hosting/API access before committing to an adapter. Generic IMAP-only systems are outside the initial Apps Script implementation. |

Connecting a mailbox does not automatically grant calendar or sending permission. Request capabilities when needed and show failures per connection. School/organization controls, access revocation, reauthentication, and restrictions on moving data to another account must be respected. The app cannot bypass institution policy.

Microsoft application registration and the user's ability to create/use it are unresolved setup prerequisites. Standard Graph access is not itself a promise that a suitable registration can be established with this user's accounts at no cost. If paid setup would be necessary, stop that integration and report the limitation without changing the zero-cost constraint.

The initial conversational scope is controlling tasks, viewing relevant source-message previews, drafting/rephrasing instructed replies, and explaining the assistant's recorded actions. A full replacement inbox, unrestricted search across every mailbox, and general web-research chat are not included in the first release. This is a proposed scope boundary for review, not a requirement stated by the user. Relevant source messages remain accessible through direct links or previews.

## Shared data and continuity

Use a private Google spreadsheet as a small structured data store. The user interacts with the app, not spreadsheet rows. Store connections' nonsecret metadata, conversations, messages, reply drafts, tasks, source references, routes, calendar-entry mappings, sync cursors, and action outcomes in defined tables.

Never store passwords, OAuth tokens, client secrets, or AI keys in that spreadsheet, downloaded exports, source files, or browser storage. Store connection secrets only in restricted server-side OAuth/configuration storage, and validate the platform's credential protection against provider requirements before live integration.

Do not mirror entire mailboxes. Fetch source content only for the feature being performed; retain the minimum task data and source identifiers needed. Cache source excerpts only when permitted and necessary, with deletion/expiry behavior. Saved user chat history is separate from a permanent email archive.

Every submitted message is saved to a conversation identifier before processing. Save its response and action status so a second device can retrieve the same thread, including a response that finished after the first device closed. Save reply drafts explicitly and synchronize them. Version concurrent edits and reject or resolve stale changes rather than silently overwriting newer text. Prevent repeated processing of the same request from sending duplicate messages.

Refresh shared state when the app opens or regains focus; use modest periodic refresh while visible. Version one promises saved continuity after synchronization, not instantaneous push updates or unlimited model context. The model receives relevant context within its limits, even though older saved messages remain browsable.

Offline source retrieval, calendar writes, AI requests, and sending are unavailable. Show the most recent successful synchronization and pending status honestly. Never label a local or failed action as completed remotely.

## Routing and manual control

A routing rule contains source account(s), source type, optional sender/course/folder/label/keyword conditions, priority, destination calendar(s), reminder preferences, and whether to act automatically, request review, or ignore the item.

Defaults and precedence:

1. An explicit per-item override takes precedence.
2. Otherwise the highest-priority matching enabled rule applies.
3. Otherwise use the source account's configured default.
4. If none is configured, retain the task and request a destination; do not write to an arbitrary calendar.

Multiple destination calendars must be explicit in one effective rule; ordinary overlapping rules do not create accidental copies. A master-calendar mode supplies one chosen destination for all sources. Preview rule effects before saving, and clearly explain whether a rule overrides or copies an item.

Example routes: A to Calendar D; C and D to Calendar B; Outlook to Calendar A; or all accounts to one Master Calendar.

Route changes apply to future items by default. Moving existing managed entries is a separate operation that reports partial failures and can be retried without creating duplicates. Sync must never delete unrelated calendar entries.

Manual controls include adding a personal task/event, editing notes and reminders, choosing destinations, scheduling study sessions, dismissing/restoring an import, completing a personal task, pausing accounts or automation, disconnecting an account, and inspecting recent actions.

Dismissal is remembered so the next sync does not recreate an item. By default, dismissing an imported task removes only its assistant-created calendar entries; it does not delete the email or the Classroom assignment. Personal completion does not submit coursework. Show official Classroom status separately.

Cross-service duplicate prevention is required for identifiable items: a Classroom assignment and an email containing its exact course/work identifiers become one task with multiple source references. Repeated provider message IDs are processed once. Matching an arbitrary forwarded or rewritten message by similar wording alone is insufficient evidence to merge tasks; show uncertain matches for review. If a source points to an already existing calendar event, link it rather than blindly creating another entry in that same destination. Automatic acceptance of invitations and general ICS/attachment processing are outside the first release.

Keep the official deadline separate from the user's planned finish date or study time. A calendar edit to an assistant-created personal schedule updates that plan; it does not rewrite an official assignment deadline. When source information conflicts, flag the conflict or use an explicitly configured precedence rule. Missing email times remain unknown; do not invent an official deadline time.

## Background automation and capacity

The proposed conservative starting interval is approximately 30 minutes per account, with a manual Sync now action. This revises the earlier provisional 10-15 minute target in light of seven to eight accounts. It is a builder proposal, not an accepted user latency requirement. Shorter intervals require measured capacity evidence.

Use scheduled incremental polling rather than paid push infrastructure. Gmail history and Microsoft message change tracking should avoid rereading whole inboxes. Classroom requires a bounded incremental reconciliation strategy. Initial imports use a user-selectable recent window, with a seven-day default, visible progress, pagination checkpoints, and bounded batches.

For nine accounts, a 30-minute interval implies 432 account-check opportunities daily before retries and calendar reconciliation (384 for eight accounts). This is a scheduling estimate, not a statement that each check takes one API call. Google's current consumer trigger allowance is 90 minutes/day. At 48 scheduling rounds/day that is an average ceiling of 112.5 seconds per round before safety margin. A candidate aggregate budget of 60 seconds/round would use approximately 48 minutes/day; actual feasibility must be measured with linked accounts, including AI calls. Budget exhaustion may defer an account beyond 30 minutes, so display actual sync age rather than an unconditional timing promise.

Set a bounded execution budget, rotate accounts fairly, checkpoint work, back off on errors, and defer remaining work. A problematic mailbox must not starve the others. Match timing to measured usage and expose overdue checks. Quotas can change and there is no guaranteed free-service SLA.

Structured Classroom data and clear deterministic patterns should work independently of AI. Run only selected candidate messages through AI. If AI limits are reached, retain ambiguous items for later/review, continue safe structured synchronization, and leave manual forms available. There is no paid fallback.

## AI and instructed replies

Proposed AI provider: Groq's free tier, subject to account eligibility and its actual available models/limits. Enable Zero Data Retention for ordinary inference and confirm current no-training terms. Explicitly explain external processing during setup; the user must choose to enable it before mailbox content is transferred. Provider credentials remain on the server.

Do not use Gemini's unpaid API as the default private-email processor; its published unpaid-service terms are unsuitable for sensitive/personal email content. Do not claim the proposed free model has identical capability or capacity to Gemini.

Treat emails, coursework, and calendar text as untrusted content. They cannot authorize a send, change routing/settings, request other mail, or expand permissions. AI returns structured proposals; deterministic application controls validate and execute supported operations.

For replies, the user selects the source message, supplies the intended content, and chooses draft or send. A request to reply without content must ask for that content. Rephrasing cannot invent reasons, facts, attachments, dates, or commitments. Default to a preview for rephrased replies; a clear user instruction to send supplied content may authorize sending without an additional confirmation.

Bind each send to a particular source account, recipient set, thread, and content version. Later content/recipient changes invalidate prior send authorization. Never automatically replay an uncertain send after a timeout; reconcile its status first. Microsoft/Gmail send status may require a pending/unknown state instead of a false success claim.

## Zero-cost operation

- Use free provider allowances only, on projects/accounts without paid billing enabled for this app.
- Do not attach a payment method, upgrade a tier, enable metered features, or depend on promotional credits.
- Use the supplied hosting URL and the user's existing mailbox/storage entitlements.
- Stop/defer when quotas or storage limits are reached. Explain which capabilities are affected.
- Avoid health checks, retries, and UI refresh loops that consume the allowance without useful work.
- Retain exportable app-owned task/chat/settings data so a free-plan change does not trap the user's work.
- If a required capability cannot meet zero cost, report it as blocked/unsupported rather than promise full coverage.

The target is zero service expenditure under current available allowances, not a guarantee that every supplier will provide the same free service forever.

## Validation and delivery sequence

1. Prove access and zero-cost setup with two distinct Google accounts and an Outlook account when registration is available. Verify writable calendar access, owner-only UI, account isolation, token refresh, and reconnection. No paid services are activated. Use selected sample data and an explicitly identified test calendar.
2. Demonstrate the same saved conversation and draft on phone and laptop, including a response completing after the first device closes.
3. Demonstrate A-to-D and C/D-to-B routing, master-calendar mode, manual overrides, and source-account-specific replies.
4. Verify repeated notifications/imports update existing entries; duplicate retries do not send mail twice; dismissed items stay dismissed; external edits preserve official deadlines; partial failures remain visible.
5. Measure scheduled runtime and AI usage with all supplied connections, including up to nine and representative traffic. Reduce frequency or defer work if required by free allowances. Never certify an unmeasured 15-minute service level.
6. Deliver source, setup instructions, provider registration instructions, and a private deployment after access is authorized. The Google and Microsoft account consent flows are user actions; implementation cannot grant those permissions by itself.

## Open constraints and builder decisions

No additional user preference is required to prepare an implementation plan once this design is approved. The exact account addresses/providers can be entered during setup; do not ask for passwords. No account has been linked, no provider registration has been verified, and no workload has been benchmarked.

Builder decisions proposed for approval: web interface rather than native APK; one owner Google account and private shared spreadsheet; explicit OAuth connectors; an initial 30-minute schedule; the routing precedence described above; selective Groq inference with Zero Data Retention; a draft-first default for rephrased replies.

The builder may choose file structure, UI styling consistent with a simple mobile interface, test framework, internal schema details, pagination sizes, and retry thresholds. Those choices must preserve the acceptance criteria and cost constraint. WhatsApp, arbitrary IMAP providers, Teams assignments, full offline operation, a paid cloud backend, and public-user onboarding are outside version one.

## Primary references

- [Apps Script overview](https://developers.google.com/apps-script/overview)
- [Apps Script web apps](https://developers.google.com/apps-script/guides/web)
- [Apps Script OAuth2 library, including multiple service connections](https://github.com/googleworkspace/apps-script-oauth2)
- [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
- [Apps Script scheduled triggers](https://developers.google.com/apps-script/guides/triggers/installable)
- [Google Calendar sharing and access](https://developers.google.com/workspace/calendar/api/concepts/sharing)
- [Classroom published coursework access](https://developers.google.com/workspace/classroom/reference/rest/v1/courses.courseWork/list)
- [Google Workspace data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy?hl=en)
- [Microsoft mail permissions](https://learn.microsoft.com/graph/permissions-reference?view=graph-rest-1.0)
- [Microsoft application registration prerequisites](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)
- [Microsoft consent restrictions](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent)
- [Microsoft Graph standard and metered APIs](https://learn.microsoft.com/en-us/graph/metered-api-overview)
- [Groq free/paid billing distinction](https://console.groq.com/docs/billing-faqs)
- [Groq rate limits](https://console.groq.com/docs/rate-limits)
- [Groq data controls](https://console.groq.com/docs/your-data)
- [Groq training and retention FAQ](https://trust.groq.com/faq?s=9pcm46fyh5sypzqgtfto)
- [Gemini unpaid-service terms](https://ai.google.dev/gemini-api/terms?hl=en)
