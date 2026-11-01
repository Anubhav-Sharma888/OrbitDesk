# OrbitDesk setup and run guide

Status: code-ready development checkpoint. Deployment and live Google access require the human steps in [tomorrow-checklist.md](tomorrow-checklist.md); nothing here authorizes live sends, calendar mutations or billing.

## Local development

Node.js 24 or newer.

```sh
npm ci --ignore-scripts
npm run typecheck   # tsc --noEmit
npm test            # vitest (core/contracts/integration, no network)
npm run build       # dist/apps-script + dist/web + ESM test twin
npm run test:browser  # Playwright; starts the labelled demo server automatically
npm run preview     # same demo server alone, on 127.0.0.1:4174
```

The local demo (`npm run preview`) runs the **real** application service and domain modules with simulated external providers. It binds 127.0.0.1 only, holds one shared in-memory store per process (open two browser windows: a task created in one is visible after refresh in the other — the phone/laptop continuity shape), labels every sample row "(sample)", and performs no network calls. Its reset/seed endpoints answer 404 unless the server was started with `ORBITDESK_DEMO_ALLOW_RESET=1`, and the demo code is never bundled into the Apps Script deployment.

Browser acceptance against the integrated backend (not the in-page UI-contract fixture):

```sh
ORBITDESK_DEMO_ALLOW_RESET=1 node tests/browser/demo-server.mjs   # window 1 (tests seed state through guarded /__test endpoints)
ORBITDESK_BASE_URL=http://127.0.0.1:4174 npm run test:browser     # window 2
```

## Apps Script deployment (owner-only, after human authorization)

1. Open the Google Apps Script project (see docs/google-setup.json for the project/script IDs) and paste the built `dist/apps-script/Code.gs`, `dist/apps-script/Index.html`, `dist/apps-script/appsscript.json` (or push with clasp).
2. Script properties (restricted; never in code, Sheets, exports or chat):
   - `OWNER_EMAIL` — the owner Google account, lowercased comparison target.
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — the manual/direct OAuth web client.
   - `GOOGLE_AGENT_CLIENT_ID`, `GOOGLE_AGENT_CLIENT_SECRET` — the separate background/agent client used by scheduled sync.
   - `STORAGE_SPREADSHEET_ID` — the private Google Sheet that holds all app-owned records (first worksheet; the header row is created on first save).
   - Optional AI (only if you explicitly want proposals): `GROQ_API_KEY`, `GROQ_MODEL`, `GROQ_FREE_PLAN_CONFIRMED='true'`. AI also requires explicit in-app consent; there is no paid fallback and no default key.
3. `appsscript.json` scopes: `script.external_request`, `userinfo.email`, `spreadsheets` (private storage). Per-account Gmail/Calendar/Classroom access uses the vendored OAuth2 library with explicit per-account grants — not the script's own scopes.
4. Deploy as web app: execute as **user deploying the script**, access **only myself**. The RPC guard derives the actor from the signed-in session; other Google accounts get a fail-closed page.
5. Do **not** install a time-driven trigger until the live checklist has passed for every account/destination you intend to automate; automation is off by default and `scheduledSync` honors `settings.automationEnabled`.

## Storage layout

All app-owned records (settings, connections metadata, conversations, messages, tasks, drafts, routes, sources, activity, sync checkpoints, budgets) live in the private spreadsheet through a versioned record store. Credentials and tokens never enter the Sheet: they stay in restricted script properties / the OAuth2 property store. Exports exclude connections and secrets by design.

## Troubleshooting

- `SETUP_REQUIRED: Set the STORAGE_SPREADSHEET_ID...` — the property is missing or the spreadsheet needs at least one worksheet. Because storage opens before the app service, this surfaces as an error alert (not the in-app SETUP banner); the banner's `setupRequired` list covers checks made once the service is up (currently OAuth client credentials).
- `UNAUTHORIZED: Owner access required` — you are signed into a different Google account than `OWNER_EMAIL`.
- `BUSY` — another web/trigger execution holds the script lock; retry shortly.
- Browser shows the SETUP banner — check `state.app.setupRequired`; it lists what the configured setup checks found (OAuth client credentials). A missing storage spreadsheet appears as the SETUP_REQUIRED error above instead.
