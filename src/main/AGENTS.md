# src/main — agent notes

## SoR write audit log (`sor-write-log.ts`)

Every outbound write to an external system-of-record (Jira today; schema-extensible
to Salesforce / HubSpot / Linear) must be logged to `sor-writes.db`. The convention:

1. Push functions in the integration client (e.g. `jira-client.ts`) take an
   **optional** `provenance?: WriteProvenance` trailing parameter. Callers that
   know the source meeting / task / confidence pass it; others can omit.
2. The push function body:
   - Calls `recordWrite(...)` with `result: 'pending'` and stashes
     `pushParams` (enough to re-run the write on retry).
   - Performs the actual HTTP call.
   - Calls `markCompleted(id, 'success' | 'failed', errorMessage?, {targetRecordId, targetRecordUrl}?)`
     on settlement.
3. For `update` and `transition` operations: do a GET-before-write so
   `fieldDiffs.before` reflects real pre-write state. The extra round trip is
   accepted (documented in PRD) because diff accuracy is the whole product.
4. For `create`: write with `targetRecordId: '(pending-create)'` and patch the
   real key into the entry via `markCompleted`'s `updates` argument on success.

Retry path: `retryJiraWrite(id)` (or equivalent per-system) reads `pushParams`,
increments retryCount via `incrementRetry(id)`, and calls the raw transport
directly — it does NOT re-enter the wrapper (which would create a duplicate
entry). This is why `pushParams` must carry everything needed to re-send.

The `onWriteCompleted(listener)` hook fires after every `markCompleted` — wired
in `main.ts` to push `sor:write-completed` over IPC so renderers can live-refresh
open meeting / task views.

## Testable pure helpers

`computeCreateDiffs`, `computeUpdateDiffs`, and `shouldGateWrite` are pure —
keep them that way so future integrations can unit-test their logic without
HTTP or a live NeDB.

## Approval gate (US-006)

Auto-push writes whose confidence is below the user's threshold never hit the
wire. Instead:

1. `main.ts` calls `shouldGateWrite(confidence, enabled, threshold)` — pure
   predicate, covered in `sor-write-log.test.ts`.
2. When gated, `recordWrite(...)` is called directly with
   `result: 'pending-approval'` and `approvalPath: 'opt-in-gated'`. The push
   function is NOT invoked and the local task's `source` field is NOT patched
   (both happen on approve).
3. A row is also inserted into `sor-pending-approvals.db` carrying the
   `pushParams`, `meetingTitle`, and `linkedTaskId` needed to re-run. Keyed by
   the same id as the `sor-writes.db` entry.

Approve path (`sor:approve` IPC): `approveJiraWrite(id, pushParams)` dispatches
the stashed params and calls `markCompleted`. No `incrementRetry` — this is a
first-time push, not a retry. After success the linked task's `source` field
is patched (same linkage the auto path would have done) and the pending row is
removed.

Reject path (`sor:reject` IPC): `markCompleted(id, 'failed', 'User rejected')`
+ `removePending(id)`. Keeps the audit trail honest — rejected writes are
visible in the receipts feed with their reason.

**Gotcha: confidence source.** The PRD lets writes without a confidence value
proceed unfiltered. Today the only signal available is the jira-matcher's
`bestMatch.similarity` (0..1) — `main.ts` plumbs that as
`provenance.confidence`. If a future extractor change produces per-item
confidence, the gate starts firing on that signal too — no code change needed.

**Gotcha: electron-store additive defaults.** `sor.jira` is newly nested inside
the pre-existing `sor` key (added in US-005). electron-store only applies
top-level defaults on first install, so existing users need the
`getSorJiraPrefs()` safe accessor in `config.ts` — don't read `sor.jira.*`
directly off `getConfig()` or you'll hit `undefined` on migrated stores.

## Slack integration modules

Six modules implement the Slack integration pipeline:

- **`slack-oauth.ts`**: One-click managed OAuth. Generates an ephemeral RSA keypair, opens Slack in the system browser, polls the hosted broker, decrypts the one-time AES-GCM handoff, validates the `xoxp` token, and returns it only to the main process. Forks can override the broker with `INWISE_SLACK_OAUTH_BROKER_URL`.
- **`slack-client.ts`**: Local Slack API client. Channel threads require an `xoxp` user token. History and replies fully consume Slack's cursor pagination at the non-Marketplace page limit (15); all API calls honor 429/Retry-After backoff.
- **`slack-normalizer.ts`**: `normalizeSlackThread(messages, meta)` converts a thread into a `NormalizedConversation` compatible with `createMeeting()` + `extractInsights()`.
- **`slack-ingestion.ts`**: Pure partition/activity/quiet-window helpers. Keep them free of Electron and persistence so edge cases remain directly testable.
- **`slack-cursor-store.ts`**: Separate electron-store (`slack-cursor-state`) for per-channel timestamp cursors, pending threads, and processed-thread dedup that survive restarts.
- **`slack-poller.ts`**: Persists discovered thread parents before committing history, reevaluates pending threads even on empty history polls, and serializes API calls to cooperate with Slack rate limits.

**Pipeline flow**: fully paginate `getChannelHistory(cursor)` → persist thread parents → commit timestamp cursor → reevaluate pending `getThreadReplies()` → quiet-window check → normalize/create/extract/save → mark processed + remove pending.

**Key invariants:**
- Never commit a history cursor until all pages are fetched and loose messages are safely processed.
- Never mark a thread processed with an empty reply set or a failed pipeline.
- Threads only process after `slackInactivityWindowMin` minutes of silence, including across app restarts.
- Outbound Wiser notes are explicit user actions and are restricted to configured write channels.
- OAuth handoff private keys and poll secrets are never persisted or exposed through renderer IPC; only the validated `xoxp` token is written to local config.
