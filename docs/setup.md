# OrbitDesk setup and run guide

Status: code-ready development checkpoint. Deployment and live Google access require the human steps in [tomorrow-checklist.md](tomorrow-checklist.md); nothing here authorizes live sends, calendar mutations or billing.

## Local development

Node.js 24 or newer, Windows PowerShell (the project is developed and verified with Windows-native Node.js, npm and Git; no WSL or Linux tooling is used).

**Runtime caution (measured):** `npm run …` children inherit the Node runtime that launched npm. If `node -v` in your shell is older than 24, npm scripts run under it and fail with `EBADENGINE`. Fix: put a Node 24 installation first on `PATH` (or launch npm through its binary: `& "<Node24>\node.exe" "<npm>\npm-cli.js" run test`). Confirm with `node -v` in the same shell before running anything.

```powershell
node -v                                  # must print v24 or newer in THIS shell
$env:PATH = "<Node24-install-dir>;" + $env:PATH   # if needed
npm ci --ignore-scripts
npm run typecheck   # tsc --noEmit
npm test            # vitest (tests/contracts + tests/integration, no network)
npm run build       # dist/apps-script + dist/web + ESM test twin
npm run test:browser  # Playwright; starts the labelled demo server automatically
npm run preview     # same demo server alone, on 127.0.0.1:4174
```

Artifact integrity (optional but recommended before deploying):

```powershell
Get-FileHash -Algorithm SHA256 dist\apps-script\Code.gs, dist\apps-script\Index.html, dist\apps-script\appsscript.json
# At commit c954a50 these are:
# Code.gs         6C7FCF1C6818F71596D763ECE60D3D9FF8AF1F70C12811EED1F356665AED0EAB
# Index.html      F2966021AAA0A0210EE9FC2DE7C68330B2190F92B57EE76E3878D8B8CDC2AB88
# appsscript.json C3CCD9560D912709762E6BE6044D0C21ABC514F0647CF33C5A16A3DD272D8B6E
```

Isolated clean-install variant (never touches your main checkout's `node_modules`):

```powershell
git archive --format=zip -o "$env:TEMP\orbitdesk-clean.zip" <commit>
Expand-Archive "$env:TEMP\orbitdesk-clean.zip" "$env:TEMP\orbitdesk-clean"
Set-Location "$env:TEMP\orbitdesk-clean"
npm ci --ignore-scripts
npm run typecheck; npm test; npm run build
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
