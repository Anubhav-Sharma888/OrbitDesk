## Gate 2 VERIFIED — owner Gmail read-only connection (2026-11-15)

Owner-observed in the deployed app: Accounts → Connect Google account → owner Gmail entered → **only `mail.read`** selected → Begin Google authorization → consent accepted (testing-mode unverified-app path; identity-bound chooser). Callback succeeded; after a full reload the Accounts panel shows the owner identity, status **active**, and the single **`mail · read`** capability badge.

Evidence note: the owner confirmed smooth completion without a verbatim scope-list read-back; the granted token cannot exceed the requested scopes because the authorization request is constructed server-side from the selected capabilities (openid + userinfo.email + gmail.readonly only).

**Status: OWNER GMAIL READ-ONLY CONNECTION VERIFIED.** A successful connection does not establish that a Gmail import has run — Sync now is explicitly deferred to a later check. No calendar/send/classroom capabilities were granted; the BMU education-account Classroom validation is deferred separately.

Next gate: Gate 3 — dedicated-calendar validation (one rule, one disposable destination, complete/dismiss/restore cycle). Note for Gate 3: connecting with calendar capabilities must include `mail.read` in the same selection, because a manual re-connection replaces the connection's capability set with the newly granted ones (no union).
