# OrbitDesk

Private personal assistant for multiple Gmail/Google Workspace accounts, Google Calendar routing and Google Classroom, with a shared phone/laptop workspace and user-instructed replies.

**Development checkpoint — not deployed or live-validated.** Fresh checks: 95 core tests pass, TypeScript passes and the build passes. UI/backend integration and independent release review remain pending. ZCode's project exists but has no OrbitDesk tasks yet.

See [current progress](docs/progress-2026-10-29.md), [scope](docs/spec.md), [implementation plan](docs/implementation-plan.md) and [human checklist](docs/tomorrow-checklist.md).

No billing activation or paid fallback. Microsoft and WhatsApp are excluded. Never commit credentials.

## Local checks

Node.js 24 or newer:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

Browser acceptance currently includes a UI contract fixture; full application integration is the next milestone. No production deployment is included.
