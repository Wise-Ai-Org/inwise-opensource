# inwise-opensource — System-of-Record Sync Transparency

## Context

Today inwise-opensource auto-pushes meeting-extracted tasks to Jira (and, with `addJiraComment`, appends notes to existing stories) via the auto-push pipeline in `src/main/main.ts:390` and the on-task-update auto-sync in `src/main/main.ts:984`. The push code in `src/main/jira-client.ts` is solid. **What's missing is the user-facing receipt trail.**

Pushes log to `console.log` and emit a single `jira:auto-synced` IPC event that's gone the moment the renderer processes it. There is no persistent record of what got written, when, to which Jira issue, and how it changed. A user who finishes a meeting has no way to see "5 things just got pushed to Jira" — the value happens silently.

This PRD adds the local audit log that captures every SoR write, plus four user-facing surfaces over it. Scope is **Jira-only for now** because Jira is the only SoR currently wired into OSS; the schema is shaped to extend to Salesforce, HubSpot, Linear, etc. when those land.

## Goals

- **Every push is logged locally and durably.** A user can answer "what did Inwise write to Jira from this machine?" at any point.
- **Per-meeting receipt** — the moment a meeting wraps, the user sees what was pushed.
- **Per-entity history** — on a Task detail view, the user can see every Jira write tied to that task with field-level diffs.
- **Settings status** — a small block in Settings shows connection state + write counts + recent failures per integration, no deep analytics.
- **Optional approval gate** — power users keep auto-push; cautious users opt in to "approve before low-confidence writes."

## Non-goals

- No multi-user approval workflows (single-user OSS only).
- No cloud-side audit log, no telemetry, no remote dashboards.
- No SoR integrations beyond Jira (Salesforce/HubSpot/Linear are deferred — schema must be extensible).
- No 30-day trend charts, error-rate graphs, or retry-queue management UI (Team/Enterprise web concerns).
- No automatic rollback. Failed writes can be retried; successful writes are not undone by Inwise.

---

## User Stories

### US-001 — SoRWriteLog foundation + Jira push instrumentation

**As a user**, every time Inwise writes to my Jira, I want a durable local record of exactly what happened so the rest of the transparency UI has data to render.

**Why broken today:**
Pushes in `src/main/jira-client.ts` (`createJiraIssue`, `updateJiraIssue`, `transitionJiraIssue`, `addJiraComment`) only emit `log('info', ...)` lines and a transient `jira:auto-synced` IPC. Nothing is queryable later.

**Acceptance criteria:**

- New NeDB collection `sor-writes.db` opened in main process alongside the existing collections. Schema:
  ```
  {
    id: string                       // uuid
    targetSystem: 'jira'             // extensible enum, future: 'salesforce' | 'hubspot' | 'linear'
    targetRecordId: string           // e.g. "PROJ-123"
    targetRecordUrl: string          // deep link to the SoR record
    operation: 'create' | 'update' | 'transition' | 'comment'
    fieldDiffs: Array<{ field: string, before: any, after: any }>  // empty for 'comment'; populated for create/update/transition
    commentBody?: string             // populated for 'comment' operation only
    sourceMeetingId?: string         // FK to meetings.db
    sourceTranscriptSpan?: { start: number, end: number, snippet: string }  // 1–2 sentence quote
    linkedTaskId?: string            // FK to tasks if the write is task-driven
    confidence?: number              // 0..1 if extractor provides one; undefined otherwise
    approvalPath: 'auto' | 'user' | 'opt-in-gated'
    result: 'success' | 'failed' | 'pending-approval' | 'retrying'
    errorMessage?: string            // populated when result='failed'
    createdAt: number                // unix ms
    completedAt?: number             // unix ms (success or final failure)
    retryCount: number               // 0 default
  }
  ```
- New module `src/main/sor-write-log.ts` exposes:
  - `recordWrite(entry: Omit<SoRWriteEntry, 'id'|'createdAt'|'retryCount'>): Promise<string>` — returns id
  - `markCompleted(id: string, result: 'success'|'failed', errorMessage?: string): Promise<void>`
  - `incrementRetry(id: string): Promise<void>`
  - `listRecent(limit: number, sinceMs?: number): Promise<SoRWriteEntry[]>`
  - `listByMeeting(meetingId: string): Promise<SoRWriteEntry[]>`
  - `listByTaskId(taskId: string): Promise<SoRWriteEntry[]>`
  - `listByTargetRecord(system: string, recordId: string): Promise<SoRWriteEntry[]>`
  - `aggregateByIntegration(sinceMs: number): Promise<Array<{system: string, total: number, success: number, failed: number, lastWriteAt?: number}>>`
- Instrument every push function in `jira-client.ts`:
  - Wrap the push body so a `recordWrite(...)` is logged with `result: 'pending'` *before* the network call.
  - On HTTP success, call `markCompleted(id, 'success')`.
  - On HTTP failure, call `markCompleted(id, 'failed', err.message)`.
  - For `updateJiraIssue` and `transitionJiraIssue`: compute `fieldDiffs` by reading the issue's current state via `jiraFetch(GET)` *before* the write so before/after is accurate. (One extra GET per update; acceptable.)
  - For `createJiraIssue`: `fieldDiffs` = the fields being created with `before: null`.
  - For `addJiraComment`: `commentBody` = the comment text; `fieldDiffs: []`.
- Update both auto-push pipelines:
  - `src/main/main.ts:390` (after-meeting auto-push) — pass `sourceMeetingId`, `sourceTranscriptSpan`, `linkedTaskId`, `approvalPath: 'auto'` into the push functions.
  - `src/main/main.ts:984` (on-task-update auto-sync) — pass `linkedTaskId`, `approvalPath: 'auto'`. No meeting source.
- Push functions take an optional `provenance` parameter so callers outside the auto-push paths (manual push, future SoRs) can supply or omit context cleanly.
- Add IPC handlers:
  - `sor:listRecent` — `(limit, sinceMs?) → SoRWriteEntry[]`
  - `sor:listByMeeting` — `(meetingId) → SoRWriteEntry[]`
  - `sor:listByTaskId` — `(taskId) → SoRWriteEntry[]`
  - `sor:listByTargetRecord` — `(system, recordId) → SoRWriteEntry[]`
  - `sor:aggregateByIntegration` — `(sinceMs) → AggregateRow[]`
  - `sor:retry` — `(id) → { ok: boolean }` re-runs the original push using stored params; increments `retryCount`; logs a new entry linked back via `previousAttemptId` field if needed (or update existing — pick one and document).
- Emit `sor:write-completed` IPC on every `markCompleted` so renderers can refresh live.
- On app startup, scan for entries stuck in `result: 'pending-approval'` or `'retrying'` older than 24 hours — surface a one-time notification *"N Jira writes were interrupted. Open Settings → Integrations to retry."*
- Typecheck passes.
- Tests pass: unit tests for `recordWrite` → `markCompleted` lifecycle; `fieldDiffs` computed correctly for update vs create vs comment; aggregate query returns correct totals; retry increments `retryCount` and re-runs.

---

### US-002 — Per-meeting "what this meeting wrote" trace

**As a user**, when a meeting wraps and Inwise pushes things to Jira, I want to immediately see what got pushed — both as a notification and persistently on the meeting's detail view.

**Acceptance criteria:**

- After the after-meeting auto-push pipeline (`src/main/main.ts:390`) completes, query `sor-writes.db` for entries with `sourceMeetingId === thisMeeting.id`. Surface results two ways:
  - **Desktop Notification** (replaces the current generic "auto-synced" event): *"Meeting '{title}': {N} updates pushed to Jira."* (or "{N} pushed, {M} failed" if failures exist). Action button `[See details]` opens the main window to the meeting detail view scrolled to the new "What this meeting wrote" section.
  - **Persistent Meeting Detail section.** In `src/renderer/views/communications/TranscriptReviewModal.tsx` (or the meeting detail page, whichever is the canonical post-meeting view today — verify and use the right one), add a "What this meeting wrote" section above or below the extracted-actions block. Renders the SoR writes for this meeting:
    - Group by `targetSystem` (today: Jira only, but render the grouping so future SoRs slot in).
    - Each row: operation badge (`Created` / `Updated` / `Transitioned` / `Commented`) + Jira key (clickable, opens `targetRecordUrl` in browser via `shell.openExternal`) + one-line summary (e.g. "Status: Demo → Proposal" for transition; "+2 fields" for update; "Comment added" for comment; "New issue created" for create).
    - Click a row to expand: full `fieldDiffs` table (field, before, after) or comment body; the source transcript snippet (from `sourceTranscriptSpan`) shown as a quote with timestamp.
    - Failed writes shown with a red badge + error message + `[Retry]` button (calls `sor:retry`).
- The section uses the existing tasks/communications styling — no new design system. Match `JiraMappingModal.tsx` patterns where applicable.
- If `sor-writes.db` returns zero entries for this meeting (e.g., auto-push was off, or extraction yielded no actionable items), the section is hidden — don't render an empty state.
- Listen for `sor:write-completed` IPC in the renderer to refresh the section live (e.g., a retry succeeds while the user is looking at the meeting).
- Typecheck passes.
- Browser-verify with `dev-browser` skill: simulate a meeting that produces 3 Jira pushes (2 success, 1 failure); confirm the notification appears with correct counts; open the meeting detail; confirm the section renders 3 rows with correct grouping; expand a row; click a Jira key; click `[Retry]` on the failed one and confirm it re-runs.

---

### US-003 — Settings → Integrations status block

**As a user**, I want a small block in Settings that tells me at a glance: is each integration connected, when did it last write, how many writes this month, how many failed.

**Acceptance criteria:**

- In `src/renderer/Settings.tsx`, add a new "Integrations" section (or extend the existing Jira section into one). Per-integration card:
  - **Header**: integration name + connection status pill (`Connected` / `Disconnected` / `Auth expired`).
  - **Counts row** (computed via `sor:aggregateByIntegration` for the last 30 days): *"{success} writes · {failed} failed · last write {relative time}"*. If no writes yet: *"No writes yet."*
  - **Recent activity** (collapsible, default collapsed): last 10 entries from `sor:listRecent` filtered to this integration. Each row mirrors the per-meeting trace row format (operation + record id + one-line summary + status). Click → opens the meeting detail (if `sourceMeetingId` present) or the SoR record.
  - **Action row**: `[Retry failed (N)]` button (enabled only when N > 0) — bulk-retries all `result: 'failed'` writes for this integration in the last 30 days. `[Disconnect]` button (existing functionality).
- Today: only the Jira card renders. The card layout is reusable so future SoRs add a card without restructuring.
- Connection status comes from existing `jira:status` IPC. Counts come from `sor:aggregateByIntegration({ sinceMs: 30d ago })`.
- Live-refresh: re-query on `sor:write-completed` IPC.
- No charts, no graphs, no per-day breakdowns. Just numbers + the recent-activity list.
- Typecheck passes.
- Browser-verify: connect Jira; confirm card shows "Connected · No writes yet"; trigger a meeting with pushes; confirm counts update; force-fail one push (e.g., disconnect mid-write); confirm `[Retry failed (1)]` enables and works.

---

### US-004 — Per-entity sync history side panel

**As a user**, when I'm looking at a Task in Inwise that's linked to a Jira issue, I want to see the full timeline of what Inwise has written to that Jira issue, with field-level diffs.

**Acceptance criteria:**

- In `src/renderer/components/tasks/TaskDetailSidebar.tsx` (the canonical task detail view — verify path), add a "Sync history" panel below the existing detail content.
- Panel shows:
  - **Header row**: *"Synced to {Jira key} · last write {relative time} · {N} writes total"* + clickable Jira key (opens `targetRecordUrl`).
  - **Timeline**: reverse-chronological list of all `sor-writes.db` entries where `linkedTaskId === task.id`. Same row format as US-002.
  - Each row expandable to show full `fieldDiffs` / comment / source transcript snippet.
  - Failed entries get the `[Retry]` button.
- Query via `sor:listByTaskId`. Paginate at 50 entries with a "Show older" button if more exist (rare but possible).
- If the task has no Jira link or no write history, the panel renders a minimal state: *"No Jira sync yet. Auto-push runs when this task is updated or after the next meeting referencing it."*
- Live-refresh on `sor:write-completed` if the entry's `linkedTaskId` matches the open task.
- Typecheck passes.
- Browser-verify: open a task that has Jira writes; confirm timeline renders correctly; expand a row; click Jira key; trigger a new write while panel is open; confirm it appears live.

---

### US-005 — Inbox receipts feed

**As a user**, when I open my Inbox, I want to see a passive feed of recent SoR writes so I can scan "what's been happening" without opening individual meetings or tasks.

**Acceptance criteria:**

- Verify which file is the Inbox view (likely a section in `src/renderer/Communications.tsx` or `MyTasks.tsx`, or the to-be-built unified Inbox from the 7-page unification — pick the canonical Inbox surface that exists today and use it; if Inbox doesn't exist as a discrete page yet, add the receipts feed as a section in `Communications.tsx` and note this for the unification work).
- Add a "Recent sync activity" section. Renders the last 25 entries from `sor:listRecent({ limit: 25, sinceMs: 7d ago })`.
- Row format mirrors US-002 / US-003: operation badge, target record, one-line summary, relative timestamp.
- Each row dismissible (a small ✕ that hides it locally — track dismissed ids in a NeDB key-value or in `config.json` as `sor.dismissedReceiptIds: string[]`; new writes that arrive after the dismissed-list timestamp re-appear naturally as a side effect of being newer).
- "Clear all" button at the section header dismisses everything currently visible.
- Failed writes are shown with the same `[Retry]` affordance as elsewhere.
- Live-refresh on `sor:write-completed`.
- Typecheck passes.
- Browser-verify: trigger several pushes; confirm receipts appear in Inbox; dismiss one; confirm it disappears; trigger a new push; confirm it shows; click "Clear all" and confirm.

---

### US-006 — Opt-in approval gate with confidence threshold

**As a cautious user**, I want to require my approval before low-confidence Jira writes happen, so I keep auto-push on for the obvious wins but get a chance to review the risky ones.

**Why this is opt-in:**
Today, auto-push runs without approval — that's the magic users like. Forcing every solo OSS user into an approval queue would regress the value prop. This story adds a config switch and a queue, both off by default.

**Acceptance criteria:**

- Add config in Settings → Integrations Jira card:
  - Toggle: *"Require my approval for low-confidence writes"* (default: off).
  - Threshold slider (visible only when toggle is on): *"Approve writes when confidence is below ___ %"* — default 60. Stored in `config.json` as `sor.jira.approvalThreshold` (0..1).
  - Helper text under the toggle: *"When on, low-confidence writes wait in your Inbox for approval instead of pushing automatically."*
- In the after-meeting auto-push pipeline (`src/main/main.ts:390`):
  - For each intended push, before calling the push function, check: if the toggle is on AND a confidence score is available AND `confidence < threshold`, then *don't* call the push. Instead, call `recordWrite(...)` with `result: 'pending-approval'`, `approvalPath: 'opt-in-gated'`, and stash the full push parameters (target system, operation type, payload) in a new collection `sor-pending-approvals.db` keyed to the `sor-writes.db` entry id.
  - Otherwise, push as today (auto path).
- New IPCs:
  - `sor:listPendingApprovals` — returns entries with `result: 'pending-approval'` joined with their stashed payloads.
  - `sor:approve(id)` — looks up the stashed payload, calls the appropriate push function with `approvalPath: 'user'` provenance, removes from `sor-pending-approvals.db`, updates the original entry's `result` to whatever the push returns.
  - `sor:reject(id)` — marks the entry as `result: 'failed'` with `errorMessage: 'User rejected'`, removes from pending.
- New "Pending approvals" section at the top of the Inbox (US-005), separate from the receipts feed:
  - One card per pending entry showing what *would* be pushed: target record + operation + proposed `fieldDiffs` or comment + the source transcript snippet that triggered it + confidence value if available.
  - Buttons: `[Approve]` `[Edit & Approve]` `[Reject]`.
  - `[Edit & Approve]`: opens an inline editor on the proposed fields/comment; on save, calls `sor:approve` with the edited payload (extends `sor:approve` to take optional override).
- Confidence source: if the existing extractor returns a confidence value, use it; if not, treat all writes as having `confidence: undefined` and **never gate them** (toggle effectively does nothing until the extractor produces confidence). Document this clearly in helper text: *"Approval gate requires the extractor to provide confidence scores. Currently active for: {list of operation types that have confidence; if none, 'No operations support confidence yet — toggle has no effect.'}"*. This avoids shipping a setting that silently does nothing.
- Pending approvals never expire on their own (user must explicitly approve or reject); but show "Pending {N} days" in the row.
- Typecheck passes.
- Browser-verify: turn toggle on; set threshold to 50%; simulate a meeting that produces a push with confidence 0.4; confirm the push does NOT go through and a pending entry appears in Inbox; click `[Approve]`; confirm the push runs and the entry moves to receipts; turn toggle off; simulate another low-confidence push; confirm it auto-pushes as before.

---

## Rollout

- One branch: `ralph/sor-transparency`.
- Schema additions: new NeDB collections `sor-writes.db` and `sor-pending-approvals.db`. No changes to existing collections.
- Additive IPCs only. The `jira:auto-synced` event continues to fire for backward compatibility with anything already listening; the new `sor:write-completed` is the canonical event going forward.
- Auto-push behavior unchanged unless the user turns on the US-006 approval toggle.

## Success signal

- After 2 weeks of dogfood: every Jira write from the OSS app is queryable in `sor-writes.db`. No "I don't know what got pushed" moments.
- A user finishes a meeting → sees the desktop notification → clicks → lands on the meeting detail with the "What this meeting wrote" section populated with accurate diffs.
- Settings → Integrations Jira card shows non-zero counts and matches what the user observes in Jira.
- Opening any task with a Jira link shows the per-entity sync history.
- A user with the approval toggle on gets a pending-approval card in Inbox for a low-confidence write, approves it, and the push completes.
- Zero regressions: existing auto-push and on-task-update auto-sync continue working for users who don't touch the new approval toggle.

## Open design questions (for follow-up, not blocking this PRD)

- Does the existing extractor produce confidence per extracted action? If yes, where does it surface and what's the typical distribution? US-006's threshold default (60%) is a guess until we know the distribution.
- Should the per-meeting trace also show *non-Jira* outcomes (e.g., "task created locally but not pushed because no Jira project mapped")? Probably yes eventually, but out of scope here — this PRD is SoR writes only.
- Should we persist `previousAttemptId` on retry-created entries, or update the original entry in-place? Pick one in implementation; this PRD allows either.
- Salesforce / HubSpot / Linear: when those land on OSS, the schema and surfaces should slot in unchanged. Confirm the `targetSystem` enum + per-integration card model accommodates them before merging this PRD.
