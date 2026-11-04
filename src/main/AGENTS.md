# src/main — agent notes

## Jira writes (see docs/JIRA_SAFETY.md)

Every Jira write goes through `submitJiraWrite` in `jira-writes.ts`: idempotency
check, the gate (`jira-gate.ts decideJiraWrite`, setting from
`config.getJiraWritePrefs()`), then either a `pending-approval` entry plus a row
in `sor-pending-approvals.db`, or a logged push via `jira-client.executeJiraPush`.
Do not call `executeJiraPush` or `jiraFetch` writes from anywhere else.

- Every write carries a numeric confidence (`jira-confidence.ts`), provenance,
  `initiator` ('user' for a click, 'system' otherwise) and, for meeting items and
  intents, an `idempotencyKey`. There is no ungated path.
- Approve / reject / retry / "Find in Jira" live in `jira-writes.ts`
  (`approveHeldWrite`, `rejectHeldWrite`, `retryJiraWrite`, `resolveHeldAssignee`).
  `writeBlocker` keeps rows that cannot go through yet (unresolved assignee, no
  sprint) held under any setting.
- `sor-write-log.ts` stays a pure log: `recordWrite` / `markCompleted` /
  queries, plus the pure diff helpers. `markCompleted` fires the
  `onWriteCompleted` listener that main.ts forwards as `sor:write-completed`.
- `config.ts` safe accessors: read `sor.jira` only through
  `getJiraWritePrefs()`; electron-store does not apply nested defaults.

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
- Outbound Ollie notes are explicit user actions and are restricted to configured write channels.
- OAuth handoff private keys and poll secrets are never persisted or exposed through renderer IPC; only the validated `xoxp` token is written to local config.
