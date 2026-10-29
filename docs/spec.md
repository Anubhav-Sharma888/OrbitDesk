# OrbitDesk active specification

Updated 29 October 2026. This supersedes Microsoft references in earlier planning documents.

Build a private, zero-additional-service-cost personal assistant for multiple Gmail/Google Workspace accounts, Google Calendar routing and Google Classroom. Owner: anubhav17826@gmail.com. Google education: anubhav.26ece@bmu.edu.in. Microsoft was removed by the user after institution denial; WhatsApp remains excluded. Account count must be deduplicated; support nine connection slots without claiming nine-account capacity has been measured.

The same saved chats, draft versions, tasks, routing rules and settings must be available on phone and laptop. Offer manual add/edit/dismiss/restore/complete/reschedule, account pause/disconnect, health and activity. Calendar routing supports any authorized source to explicit writable destinations, one master or separate routes. Item overrides outrank highest-priority enabled matching rule, then account default; no arbitrary fallback or accidental fanout.

Import bounded Gmail changes and published student Classroom work. Keep missing or ambiguous email times unknown. Classroom due components are UTC. Exact coursework references merge notifications; similar titles do not. Personal completion never submits coursework. Track official deadlines separately from personal planned times. Only mutate verified OrbitDesk-owned calendar entries; no invitations.

Replies require the user's content and explicit send instruction bound to the exact draft version, recipients, account and thread. AI may propose/rephrase but cannot authorize actions. Unknown send outcomes must not automatically resend. AI is disabled without explicit data-processing consent and a supplied, eligible free API key. No paid fallback.

Use Apps Script V8, private Sheets for app-owned records, restricted Script Properties for credentials, explicit per-account OAuth2, TypeScript, responsive HTML/CSS. Fail closed for unauthorized RPC calls. Never export or return tokens, secrets or passwords, and never mirror whole mailboxes. Render untrusted strings literally. A local demo must be labeled and use the same domain/RPC contract with sample data, without pretending live integrations work.

The user requests all independent implementation, tests and review now. Defer consent, missing credentials, actual deployment authorization, live Google tests, physical phone testing and 48-72-hour live observation to the human checklist. No live email sends, calendar mutations, billing activation or external AI processing during unattended development. Code-ready is distinct from connected/deployed/live-validated.
