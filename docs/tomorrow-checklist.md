# OrbitDesk — guided human setup checklist

One checklist for the whole deployment-to-live path. Complete the gates **in order**; each gate names the exact service and account, the purpose and minimum permission, the action **you** perform directly (never paste passwords, verification codes or client secrets into chat), the expected result with a safe verification method, and recovery/rollback. Stop at any gate and keep everything else paused. Institutional (BMU) denial at any point ends that gate's scope — respect it and continue with the remaining gates only if they do not depend on it.

**Standing rules:** zero additional expenditure (no billing activation, no paid tiers); automation and AI stay off unless a gate explicitly enables them; all local evidence was produced on Node v24.22.1 at Step 3 commit `2b51475` — expect **143/143 tests** at that commit (docs/qa-report.md); nothing here authorizes live sends or calendar mutations beyond the gate that names them.

## Gate 0 — Local reproducibility (no Google access) — VERIFIED on this machine at commit `6d17cd2`

- **Where:** your machine, a checkout of branch `develop` at commit `6d17cd2` or later. On this laptop Gate 0 has already passed: an isolated copy (created with `git archive 6d17cd2`, no node_modules/dist/credentials) installed with `npm ci --ignore-scripts` and reproduced **143/143 tests** and a byte-identical build (artifact SHA-256s recorded in docs/qa-report.md, verified independently across two environments and four consecutive builds). Remaining owner value of this gate: prove it on YOUR machine/checkout before pasting anything into Google.
- **Runtime caution (measured on this laptop):** `npm run …` children inherit the Node runtime that launched npm. If your default `node -v` is older than 24, npm scripts may run under it and fail with `EBADENGINE`. Check `node -v` first; if it is not v24+, either upgrade your default Node or launch npm through the Node 24 binary.
- **Do (either way is fine; the isolated variant never touches shared dependencies):**
  - Isolated (recommended): `git archive <commit> | tar -x -C <empty temp dir>`, then inside that copy `npm ci --ignore-scripts` and the checks below. Your main checkout's `node_modules` is untouched.
  - Direct: in your checkout, `npm ci --ignore-scripts` (replaces your local `node_modules` with the lockfile state), then the checks.
- **Checks:** `npm run typecheck && npm test && npm run build`.
- **Expected:** typecheck 0 errors; **143/143 tests** (15 files); build prints "no credentials included" and creates `dist/apps-script/` (Code.gs + Index.html + appsscript.json). At `6d17cd2` the artifact SHA-256s were: Code.gs `6c7fcf1c…ed0eab`, Index.html `f2966021…2ab88`, appsscript.json `c3ccd956…d8b6e` (full values in docs/qa-report.md).
- **Verify safely:** `node -v` ≥ 24 in the same shell; the artifact hashes match the recorded values.
- **Rollback/recovery:** none needed — a failed step leaves no side effects; fix the Node version and rerun. `npm ci` in your own checkout only replaces that checkout's local dependencies.

## Gate 1 — Owner-only deployment + private storage

- **Service/account:** Google Apps Script (script project `16gurcJgk7TdSw5d1G_HCpXbzNv62Nw0gOU5Q1HdqiOipLgQrLsu5QCFl`, project orbitdesk-personal-17826) with your **owner Gmail account** (anubhav17826@gmail.com).
- **Purpose / minimum permission:** deploy the web app to yourself only (execute as **Me** / accessible **only myself** — this is the web app's access setting, separate from OAuth data permissions), and create the private storage Sheet. The requested Google Sheets scope grants account-wide spreadsheet access. OrbitDesk is intended to use the configured private storage Sheet; that usage restriction is not a scope-enforced single-file permission.
- **Do (in order):**
  1. Apps Script editor → paste `dist/apps-script/Code.gs`, `dist/apps-script/Index.html`, `dist/apps-script/appsscript.json` (or `clasp push` if you use clasp). If a previous OrbitDesk deployment exists, update the existing script files instead of creating a second project.
  2. Project Settings → Script Properties — add any that are MISSING; **do not recreate or overwrite values that already exist** (your recorded `OWNER_EMAIL` and `GOOGLE_CLIENT_*` from the 2026-10-29 setup should be preserved as-is). Required for Gate 1 — exactly these four: `OWNER_EMAIL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `STORAGE_SPREADSHEET_ID`. `GOOGLE_AGENT_CLIENT_ID` / `GOOGLE_AGENT_CLIENT_SECRET` are deferred to step 1' (background setup — needed for Gate 5 only). GROQ_* remain optional and are deferred to Gate 6 (step 1''). Values come from your records/Google UI; **never from chat**.
  3. Drive → New Google Sheet named "OrbitDesk storage"; open it, copy the ID from the URL, put it in `STORAGE_SPREADSHEET_ID`; keep the first worksheet empty. (If a storage Sheet already exists from earlier setup, reuse it — do not create a second one.)
  4. Deploy → New deployment → Web app: execute as **Me**, who has access **Only myself**.
  1'. **Agent client (needed for Gate 5 only; may be deferred):** Google Cloud Console → Credentials → create a second OAuth client (Web application) for background sync, redirect `https://script.google.com/macros/d/<script id>/usercallback`, and put its ID/secret in the `GOOGLE_AGENT_*` properties. Until it exists, scheduled sync fails closed (`BACKGROUND_GRANT_REQUIRED` / `RECONNECT_REQUIRED`; no calendar write rides manual credentials); manual use is unaffected.
  1''. Optional (Gate 6 only): GROQ_API_KEY / GROQ_MODEL / GROQ_FREE_PLAN_CONFIRMED='true'.
- **Scopes you are agreeing to:** the script itself requests `script.external_request`, `userinfo.email` and `spreadsheets`. Note the Sheets scope is granted **account-wide by Google** — restricting it to the single storage file is an intended-use boundary, not a technical limit of the scope. The per-account Gmail/Calendar/Classroom access is separate and appears on each account's own consent screen at Gate 2 (only the capabilities you select are requested).
- **Expected:** deployment succeeds; opening the web app URL signed in as the owner loads OrbitDesk. Production setupChecks currently checks the manual Google client ID and secret. Storage is opened before those checks. A cleared banner does not establish background grants, optional AI readiness or live integration. If the app shows an error instead of loading, the setup banner or error message may name a missing property, but each Gate 1 prerequisite must be verified explicitly in Apps Script → Project Settings (all four required properties present with values), not by banner disappearance.
- **Verify safely:** open Apps Script → Project Settings and confirm all four required properties are present with values — banner disappearance is not a verification. The storage Sheet is expected to remain empty until the first save, after which it should hold app-owned records (not credentials); this describes expected behavior, not a verified guarantee.
- **Rollback:** Apps Script → Deployments → **Archive** the deployment (reversible; do not delete). **Keep the storage Sheet and script properties** — they hold your saved workspace and configuration and are reused by any later re-deploy. Deleting them is a last resort that discards saved data, not the default recovery.

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
- **Rollback:** delete the test events (they are OrbitDesk-owned; deleting them remotely is safe — the next pass reports a conflict needing review); disconnect the account; disable (not delete) the rule so the saved configuration survives.

## Gate 4 — Reply send validation (first email send)

- **Service/account:** the owner Gmail account (or another personal account you authorize).
- **Purpose / minimum permission:** validate the instructed-reply path once, to yourself, with mail.read + **mail.send**.
- **Do:** connect with send capability; import or create one message from yourself; draft a reply to your own address; Review & send; authorize the exact message.
- **Expected:** 'Sent' status; the message appears in the account's Sent mail; one send per authorization (dedupe).
- **Verify safely:** check the Sent folder of the sending account; the draft shows 'Sent'.
- **Recovery:** sends cannot be un-sent — this gate is deliberately a self-addressed message. Unknown send outcomes: check Sent in the same account/thread; never re-send on 'unknown'.

## Gate 5 — Background scheduling validation (last automation gate)

See the [Gate 5 live verification record](gate5-record.md) for the confirmed owner-account checks and the remaining acceptance criteria.

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