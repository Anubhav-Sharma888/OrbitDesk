# OrbitDesk Google implementation plan

Spec: docs/spec.md. Complete independent code and review while the user is away; defer human-dependent live checks. Use test-first behavior changes, exact verification evidence and focused local commits. Each task consumes the earlier typed interfaces. Live validation is a separate pending gate, not permission to claim integration success.

## Review Focus

1. Cross-account isolation, owner authorization, signed single-use OAuth callback, actual Google subject identity and token redaction.
2. Versioned concurrent writes, retry idempotency, atomic pending send and unknown delivery without blind replay.
3. Exact Classroom references, UTC due dates, unknown email times, exclusive all-day end and separate personal plans.
4. Destination ownership and access role, deterministic managed event IDs, foreign collisions, etag conflicts and no invitations.
5. Bounded resumable imports, fair scheduling, quota/backoff, explicit AI consent and no paid fallback.

### Task 1: Access contracts and build

Files: src/shared/contracts.ts, src/accounts/oauth.ts, src/accounts/secret-store.ts, src/providers/transport.ts, src/app/entrypoints.ts, src/app/appsscript.json, scripts/build.mjs, tests/contracts/access.test.ts, docs/access-matrix.md.

Implement owner guard, a typed narrow RPC surface, per-account OAuth broker over the Google Workspace OAuth2 library, expiring single-use owner-bound callback validation, verified identity and relink dedupe. Transport only permits supported provider paths, no redirects or raw response leakage. Vendor the official OAuth2 distribution with license/hash. Build Apps Script global entrypoints without Node APIs.

Tests: rejectsCallbackForWrongPendingConnection; replayedOrExpiredCallbackCannotExchange; deniedConsentCreatesIndependentBlockedState; responseNeverContainsToken; actualIdentityControlsConnection; serverEntryPointsSurviveBundling. Verify npm run typecheck, npm run build, npm test. Record live grants as deferred.

### Task 2: Shared records and continuity

Files: src/storage/record-store.ts, src/storage/sheets-store.ts, src/conversations/conversations.ts, src/conversations/drafts.ts, tests/integration/continuity.test.ts.

Versioned records, request-id dedupe, lock-protected writes, JSON-safe Sheet cells, conversation pagination and draft conflicts. Metadata and secrets stay separate.

Tests: savedMessageIsVisibleFromSecondClient; sameRequestIdDoesNotAppendTwice; staleDraftVersionIsRejected; formulaLikeTextRemainsLiteral. Run full suite/typecheck/build; commit.

### Task 3: Google provider adapters and imports

Files: src/providers/gmail.ts, src/providers/classroom.ts, src/sync/imports.ts, tests/contracts/providers.test.ts.

Bounded initial Gmail import with a checkpoint captured before listing, history pagination and opaque IDs, recovery from expired history, nested MIME parsing. Paged Classroom courses/coursework/submissions using published student data. Persist records before advancing cursors; token-account binding; connection-local throttling.

Tests: cursorAdvancesOnlyAfterPersistedPage; invalidCursorUsesBoundedRecovery; google429DefersOnlyThatAccount; sourceATokenNeverFetchesSourceB; nestedMimeTextIsDecoded; historyIdsRemainOpaque. Run suite/typecheck/build; commit.

### Task 4: Tasks, due dates and manual controls

Files: src/tasks/deadlines.ts, src/tasks/correlate.ts, src/tasks/task-service.ts, tests/integration/tasks.test.ts.

Strict date validation, UTC Classroom deadlines, conservative text extraction, exact assignment-link dedupe and source-scoped IDs. Preserve dismissals, overrides and local plans on later imports. Manual task controls with CAS versions.

Tests: exactClassroomNotificationMerges; similarTitlesStaySeparate; missingTimeStaysUnknown; utcClassroomNearMidnight; dismissSurvivesImport; personalCompleteDoesNotSubmit. Run suite/typecheck/build; commit.

### Task 5: Calendar routing and reconciliation

Files: src/routing/rules.ts, src/routing/reconcile.ts, src/providers/google-calendar.ts, tests/integration/routing.test.ts.

Explicit source/destination bindings and route precedence, writable role verification, deterministic event IDs and pending operation records. Verify ownership before update/delete/adoption; etag conflict handling; preserve external personal scheduling edits. No attendees or conference payload.

Tests: routesAToDAndCDToB; masterCalendarUsesOneDestination; specificPriorityAndItemOverrideWin; calendarDeniedDoesNotUseAnotherDefault; repeatedReconcileCreatesOneEvent; foreignCollisionIsNotAdopted; externalMoveChangesPlanNotOfficialDue; calendarWritesNeverInviteAttendees. Run suite/typecheck/build; commit. Defer live writes.

### Task 6: AI proposals and instructed replies

Files: src/ai/groq.ts, src/ai/proposals.ts, src/replies/policy.ts, src/replies/send.ts, tests/integration/replies.test.ts.

Strict schemas and explicit AI consent; no implicit credentials or paid fallback. Thread-safe Gmail MIME replies, exact-version send authorization, durable pending/unknown/sent states, and no automatic retry after uncertainty. User instruction is distinct from all source/AI text.

Tests: missingUserContentCannotSend; aiProposalCannotGrantSendPermission; changedRecipientOrDraftInvalidatesAuthorization; repeatedRequestDoesNotSendAgain; timeoutDoesNotBlindlyReplaySend; noConsentMakesNoAiCall; maliciousSourceCannotReadOtherAccounts; headerInjectionRejected. Run suite/typecheck/build; commit. Defer API key and live sends.

### Task 7: Scheduling and free-use boundaries

Files: src/sync/scheduler.ts, src/sync/budgets.ts, tests/integration/scheduler.test.ts, docs/operations.md.

Lock-protected, bounded rounds with durable fair rotation, per-account backoff and budgets, actual sync-age reporting and manual throttling. No paid fallback. Automation defaults off until user enables it after live access proof.

Tests: nineAccountsRotateWithoutStarvation; budgetStopsAfterCheckpoint; burstResumesWithoutDuplicatingTasks; ai429LeavesStructuredSyncUsable; noBillingFallbackExists; overlappingTriggerUsesLock. Run suite/typecheck/build; commit.

### Task 8: Complete UI, exports and release checks

Files: src/ui/index.html, src/ui/app.ts, src/ui/styles.css, src/ui/rpc.ts, src/app/service.ts, src/storage/exports.ts, scripts/preview.mjs, tests/integration/exports.test.ts, tests/browser/assistant.spec.ts, playwright.config.ts, docs/qa-report.md, docs/setup.md, docs/tomorrow-checklist.md.

Responsive colorful dark-gray UI for dashboard/tasks/agenda/chat/replies/accounts/routing/activity/settings. Shared fixture backend follows the same RPC contract and is visibly a demo. Real adapter uses owner-only Apps Script and private Sheets. Literal untrusted text; accessible keyboard/focus and mobile controls. Versioned exports/import preview exclude secrets/connections and never cause remote effects. Imported data pauses automatic actions until reviewed. Disconnect removes credentials and polling access.

Tests: phoneConversationContinuesOnLaptop; staleDraftShowsConflict; manualDismissSurvivesSync; rulePreviewShowsDestination; unwritableCalendarShowsError; missingReplyContentDoesNotSend; mobileLayoutHasUsableControls; exportContainsNoCredentials; importPreservesDraftsAndDismissalsWithoutRemoteSideEffects; disconnectRemovesTokenAndStopsPolling. Run npm run typecheck, npm run build, npm test, npm run test:browser. Obtain a fresh whole-project review and fix material findings with regression tests. Commit code-ready deliverable; list live checks without claiming they passed.
