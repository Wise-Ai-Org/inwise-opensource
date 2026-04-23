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

`computeCreateDiffs` and `computeUpdateDiffs` are pure — keep them that way so
future integrations can unit-test their diff logic without HTTP.
