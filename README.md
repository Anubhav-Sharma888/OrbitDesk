# OrbitDesk

Private personal assistant for multiple Gmail/Google Workspace accounts, Google Calendar routing and Google Classroom, with a shared phone/laptop workspace and user-instructed replies.

**Development checkpoint — code-ready, not deployed or live-validated.** Application integration milestone complete (1 November 2026): owner-only RPC service, private Sheet storage, scheduled-sync wiring, calendar reconcile stage with managed-event lifecycle, and a labelled local demo on the real backend. The production-integration corrective milestone (fair reconciliation, routing consistency, background-grant isolation, durable remote operations, event lifecycle, capability-aware imports) is verified with regression tests. Fresh checks on Node 24: TypeScript 0 errors, **135 core tests pass**, build passes, browser acceptance **14/14** (in-page harness) and **13 + 1 documented skip** (backend-driven mode). See [current progress](docs/progress-2026-11-01.md), [QA report](docs/qa-report.md), [scope](docs/spec.md) and [human checklist](docs/tomorrow-checklist.md).

No billing activation or paid fallback. Microsoft and WhatsApp are excluded. Never commit credentials. No live email send, calendar mutation or external AI processing happens in local checks — external providers are simulated there.

## Local checks

Node.js 24 or newer:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm run test:browser
```

## Local demo

```sh
npm run preview   # http://127.0.0.1:4174 — real backend, simulated providers, sample data only
```

Setup and deployment guidance (after owner authorization): [docs/setup.md](docs/setup.md).
