# OrbitDesk — guided human setup checklist

One checklist for the whole deployment-to-live path. Complete the gates **in order**; each gate names the exact service and account, the purpose and minimum permission, the action **you** perform directly (never paste passwords, verification codes or client secrets into chat), the expected result with a safe verification method, and recovery/rollback. Stop at any gate and keep everything else paused. Institutional (BMU) denial at any point ends that gate's scope — respect it and continue with the remaining gates only if they do not depend on it.

**Standing rules:** zero additional expenditure (no billing activation, no paid tiers); automation and AI stay off unless a gate explicitly enables them; all local evidence was produced on Node v24.22.1 at Step 3 commit `2b51475` — expect **143/143 tests** at that commit (docs/qa-report.md); nothing here authorizes live sends or calendar mutations beyond the gate that names them.

## Gate 0 — Local reproducibility (no Google access)

- **Where:** your machine, repo `C:\Anubhav Sharma\Projects\Automating Mailbox and Calender`, branch `develop` (commit `3906d9d`).
- **Do:** `npm ci --ignore-scripts`, then `npm run typecheck && npm test && npm run build`.
- **Expected:** typecheck 0 errors; **143/143 tests**; `dist/apps-script/` created (Code.gs + Index.html + appsscript.json). This is the reproducibility item the devops review could not verify for you; verify at commit `2b51475` or later.
- **Verify safely:** `node --version` prints v24 or newer; the build's final line says "no credentials included".
- **Rollback/recovery:** none needed — a failed step leaves no side effects; fix Node version (24+) and rerun.

## Gate 1 — Owner-only deployment + private storage

- **Service/account:** Google Apps Script (script project `16gurcJgk7TdSw5d1G_HCpXbzNv62Nw0gOU5Q1HdqiOipLgQrLsu5QCFl`, project orbitdesk-personal-17826) with your **owner Gmail account** (anubhav17826@gmail.com).
- **Purpose / minimum permission:** deploy the web app to yourself only, and create the private storage Sheet. No data access beyond the script's own Sheet.
- **Do (in order):**
  1. Apps Script editor → paste `dist/apps-script/Code.gs`, `dist/apps-script/Index.html`, `dist/apps-script/appsscript.json` (or `clasp push` if you use clasp).
  2. Project Settings → Script Properties — add exactly: `OWNER_EMAIL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_AGENT_CLIENT_ID`, `GOOGLE_AGENT_CLIENT_SECRET`, `STORAGE_SPREADSHEET_ID` (skip GROQ_* until Gate 6). Values come from your records/Google UI; **never from chat**.
  3. Drive → New Google Sheet named "OrbitDesk storage"; open it, copy the ID from the URL, put it in `STORAGE_SPREADSHEET_ID`; keep the first worksheet empty.
  4. Deploy → New deployment → Web app: execute as **Me**, who has access **Only myself**.
  1'. **Agent client (needed for Gate 5 only; may be deferred):** Google Cloud Console → Credentials → create a second OAuth client (Web application) for background sync, redirect `https://script.google.com/macros/d/<script id>/usercallback`, and put its ID/secret in the `GOOGLE_AGENT_*` properties. Until it exists, scheduled sync fails closed (`BACKGROUND_GRANT_REQUIRED` / `RECONNECT_REQUIRED`; no calendar write rides manual credentials); manual use is unaffected.
  1''. Optional (Gate 6 only): GROQ_API_KEY / GROQ_MODEL / GROQ_FREE_PLAN_CONFIRMED='true'.
- **Expected:** deployment succeeds; opening the web app URL signed in as the owner shows OrbitDesk (or the SETUP banner listing exactly the missing properties).
- **Verify safely:** open the web app → the dashboard renders; Settings shows `setupRequired` empty once properties are set; the storage Sheet stays empty until first save.
- **Rollback:** Apps Script → Deployments → delete the deployment (or Archive); delete the storage Sheet; delete the script properties. Nothing external persists.

## Gate 2 — Read-only account validation (first Google grant)

- **Service/account:** the owner Gmail account, plus the education account (anubhav.26ece@bmu.edu.in) if BMU permits.
- **Purpose / minimum permission:** verify per-account OAuth works and that ONLY the scopes you select are requested. Select **read-only** capabilities (mail.read; classroom.read for the education account) — no mail.send, no calendar.write.
- **Do:** in the web app → Accounts → Connect Google account → select read-only capabilities → Continue to Google → review the consent screen scopes → Allow. For the education account, repeat; if BMU denies API access, record the denial and skip its gates.
- **Expected:** the account card turns `active` with exactly the selected capability badges; Google's consent screen lists only the scopes matching the selected capabilities.
- **Verify safely:** Accounts panel shows the account; Activity shows 'Connected'; the storage Sheet gains connection metadata (no tokens — tokens live in restricted script properties).
- **Recovery:** Accounts → Disconnect (removes connection state and tokens server-side; revoke the grant in myaccount.google.com/permissions if desired).

## Gate 3 — Dedicated-calendar validation (first calendar writes)

- **Service/account:** the owner account's Google Calendar; **one dedicated calendar** created for this test (e.g. "OrbitDesk test").
- **Purpose / minimum permission:** validate the reconcile lifecycle end-to-end against a disposable destination with the minimum calendar scopes (calendar.list + calendar.read + calendar.write on that account).
- **Do:** connect the account with calendar capabilities; Settings → account default or a rule → the dedicated calendar (mode **automatic**); run **Sync now**; then complete/dismiss the task and confirm the event is removed; restore and confirm recreation; add a deliberately missing background grant check (Gate 5's client absent → scheduled context fails closed).
- **Expected:** one managed event on the dedicated calendar (OrbitDesk-owned: description notes and deterministic id), removed on completion/dismissal, recreated on restore, moved on route change; review decisions leave it untouched; unwritable destination → error, no write.
- **Verify safely:** eyeball the dedicated calendar; the app's Activity shows 'Calendar reconcile: …'; nothing on your other calendars.
- **Rollback:** delete the test events (they are OrbitDesk-owned; deleting them remotely is safe — the next pass reports a conflict needing review); disconnect the account; delete the rule.

## Gate 4 — Reply send validation (first email send)

- **Service/account:** the owner Gmail account (or another personal account you authorize).
- **Purpose / minimum permission:** validate the instructed-reply path once, to yourself, with mail.read + **mail.send**.
- **Do:** connect with send capability; import or create one message from yourself; draft a reply to your own address; Review & send; authorize the exact message.
- **Expected:** 'Sent' status; the message appears in the account's Sent mail; one send per authorization (dedupe).
- **Verify safely:** check the Sent folder of the sending account; the draft shows 'Sent'.
- **Recovery:** sends cannot be un-sent — this gate is deliberately a self-addressed message. Unknown send outcomes: check Sent in the same account/thread; never re-send on 'unknown'.

## Gate 5 — Background scheduling validation (last automation gate)

- **Service/account:** owner account + the agent OAuth client from Gate 1'.
- **Purpose / minimum permission:** verify scheduled sync uses the background grant, honors the automation switch, and fails closed when the grant is missing.
- **Do:** authorize background access for the account (Accounts → Authorize background access); confirm `GOOGLE_AGENT_*` properties; install a time-driven trigger ONLY now (Apps Script → Triggers → scheduledSync, e.g. every 30 minutes); enable automation in Settings; observe; then test fail-closed by revoking/pausing.
- **Expected:** trigger runs `scheduledSync`; automation disabled → `{status:'disabled'}`; enabled → pages/items with per-account health; missing/paused background grant → fail-closed (`BACKGROUND_GRANT_REQUIRED`), calendar writes stop, no manual-credential fallback; fair rotation; budgets respected.
- **Verify safely:** Activity rows ('Scheduled import complete…'), account lastSync, the dedicated calendar only.
- **Rollback:** disable automation in Settings (trigger becomes a no-op), then delete the trigger; pause/disconnect accounts; revoke the background grant.

## Gate 6 — Optional AI (only if you want proposals)

- **Service/account:** Groq account (yours), free plan.
- **Purpose / minimum permission:** enable optional reply rephrasing/proposals; the app submits one bounded source + your wording per request; no tools, no other accounts.
- **Do:** create an eligible free key; review Groq's data-processing/retention terms; put `GROQ_API_KEY`, `GROQ_MODEL`, `GROQ_FREE_PLAN_CONFIRMED='true'` in script properties; confirm your organization stays on the Free plan; enable AI + consent in Settings.
- **Expected:** rephrase proposals appear as not-saved suggestions; AI 429 leaves sync/manual controls usable; no paid fallback.
- **Verify safely:** draft → Rephrase shows a suggestion; nothing auto-saves/sends.
- **Rollback:** disable AI in Settings (consent remains but nothing runs); remove GROQ_* properties to hard-disable.

## Standing exclusions

Microsoft and WhatsApp remain excluded. Respect BMU institutional denials. Do not proceed past a failed gate. Zero additional expenditure. No passwords, codes or client secrets in chat.