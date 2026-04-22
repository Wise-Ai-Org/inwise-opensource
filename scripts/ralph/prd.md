# inwise-opensource — Action Item Lifecycle on the Person Page

## Context

Two tightly-related UX gaps on the Person drawer:

1. The existing "PENDING ACTION ITEMS" section only shows unreviewed items. The moment a user clicks **Create task** (the `+` button), the action item should move out of "pending" and into an "Active" state so the user can see *"this became a task and here's where it stands."* Today it just... stays pending forever (see hidden bug below).
2. The approve flow is one-sided: you can convert to a task (`+`) but there's no way to **reject** an action item that isn't worth acting on. It sits in the pending list until the user manually hides the meeting. Same approve/reject pattern used in Communications should apply here.

**Hidden bug motivating this PRD:** in `src/renderer/People.tsx:402-415`, `handleCreateTask` calls `api.createTask()` to create a Task but **never updates the source action item's `convertedToTaskId`**. The backend filter at `src/main/database.ts:481` (`if (item.convertedToTaskId) return false`) will therefore never fire. The field exists in the schema; no code writes to it. This needs to be fixed before the UI changes can behave correctly.

## Goals

- Rename the section title from "PENDING ACTION ITEMS" → **"Action items pending review"**.
- Add a **Reject** button (X) next to the existing **Create task** (+) button on each pending row; same approve/reject pattern as Communications.
- Fix the hidden bug: when a user creates a task from an action item, persist the link (`convertedToTaskId`) on the source insight so the item actually leaves the pending list.
- Add a second section titled **"Active action items"** on the Person drawer, showing converted tasks that are not yet done (status ≠ `completed` / `cancelled`).
- Collapse completed/cancelled items behind a `Show N completed` toggle at the bottom.
- Every transition is one-click reversible where it makes sense (un-reject puts it back in pending; un-complete is the existing Task flow).

## Non-goals

- Approve/reject on Blockers or Decisions (only action items for this round).
- Bulk approve/reject (one at a time).
- Surfacing dismissed items in a separate "Rejected" bucket (they just disappear for this round — can add later).

---

## User Stories

### US-001 — Persist convertedToTaskId and dismissed on insight action items

**As a developer**, I need writes to the source insight record so action items have durable lifecycle state instead of being stateless projections.

**Why broken today:**
- `src/main/database.ts:466-473` projects action items with `convertedToTaskId: null, taskStatus: null` as static defaults.
- `handleCreateTask` in `src/renderer/People.tsx:402-415` creates a Task but never writes back to the meeting's `insights.actionItems[i]`.
- `pendingActionItems` filter at `database.ts:481` checks a field that is never populated.

**Acceptance criteria:**
- Action items in `meeting.insights.actionItems[]` gain two optional fields: `convertedToTaskId?: string | null`, `dismissed?: boolean` (default absent / null / false — no migration needed).
- Add helper in `src/main/database.ts` exports: `convertActionItemToTask(meetingId: string, actionItemIndex: number, taskFields: object): Promise<{taskId: string}>` — creates the Task AND updates `insights.actionItems[actionItemIndex].convertedToTaskId = newTaskId` atomically. Returns the new task id.
- Add helper `dismissActionItem(meetingId: string, actionItemIndex: number): Promise<void>` — sets `insights.actionItems[actionItemIndex].dismissed = true`.
- Add helper `undismissActionItem(meetingId: string, actionItemIndex: number): Promise<void>` — clears the dismissed flag.
- `getPerson()` at `database.ts:478-487`: update the pending filter to exclude BOTH `convertedToTaskId` set AND `dismissed === true`.
- `getPerson()`: also return a new `activeActionItems` list — action items where `convertedToTaskId` is set AND the linked task has `status !== 'completed' && status !== 'cancelled'`. Join on the tasks collection to fetch current `status`, `updatedAt`, `dueDate`.
- `getPerson()`: also return a new `doneActionItems` list — action items where `convertedToTaskId` is set AND the linked task has `status === 'completed' || status === 'cancelled'`.
- The `ActionItem` interface in `src/renderer/People.tsx:59-70` mirrors the new fields.
- Typecheck passes.
- Tests pass: unit test for convertActionItemToTask (creates task + writes back), dismissActionItem (sets flag), getPerson pending/active/done partitioning.

---

### US-002 — IPC + preload bridge for convert and dismiss

**As a developer**, I need renderer-facing IPCs that wrap the new helpers so the UI can call them cleanly.

**Acceptance criteria:**
- Add in `src/main/main.ts`:
  - `ipcMain.handle('actionItem:convert', (_e, payload) => convertActionItemToTask(payload.meetingId, payload.actionItemIndex, payload.taskFields))`
  - `ipcMain.handle('actionItem:dismiss', (_e, payload) => dismissActionItem(payload.meetingId, payload.actionItemIndex))`
  - `ipcMain.handle('actionItem:undismiss', (_e, payload) => undismissActionItem(payload.meetingId, payload.actionItemIndex))`
- Expose on `src/main/preload.ts`:
  - `convertActionItem: (payload) => ipcRenderer.invoke('actionItem:convert', payload)`
  - `dismissActionItem: (payload) => ipcRenderer.invoke('actionItem:dismiss', payload)`
  - `undismissActionItem: (payload) => ipcRenderer.invoke('actionItem:undismiss', payload)`
- Mirror in `src/renderer/api.ts` so `api.convertActionItem / api.dismissActionItem / api.undismissActionItem` are callable from components.
- Typecheck passes.

---

### US-003 — Rename section label and add Reject button to ActionItemRow

**As a user**, I want to reject an action item with one click when it's not worth tracking, using the same pattern as the Communications review flow.

**Acceptance criteria:**
- Rename the section heading "PENDING ACTION ITEMS" → **"Action items pending review"** in `src/renderer/People.tsx`. Keep the same small-caps label style used by neighboring sections.
- In `ActionItemRow` (`People.tsx:188-247`), add a second IconButton next to the existing `+` Create-task button: a small `×` (use `MdClose` from react-icons, matching the TranscriptReviewModal dismiss style). Icon-only with `aria-label="Reject"` and tooltip.
- Extend `ActionItemRow` props: `onReject: (item: ActionItem) => Promise<void>`.
- Clicking Reject calls `onReject(item)` → invokes `api.dismissActionItem({ meetingId: item.meetingId, actionItemIndex: item.actionItemIndex })` → refreshes the person drawer data so the rejected item vanishes.
- Show a toast: "Rejected — won't show again" with an `[Undo]` action that calls `undismissActionItem` with the same args. Undo window: 5 seconds.
- Clicking the existing `+` now calls the new `convertActionItem` IPC instead of raw `createTask`, so `convertedToTaskId` gets persisted.
- Typecheck passes.
- Verify in browser using dev-browser skill: seed demo data, open a Person drawer with pending items, click Reject on one → gone from pending list, toast appears, Undo restores it; click `+` on another → moves from pending to Active section after US-004 ships.

---

### US-004 — Add Active action items section + collapsed Show-N-completed toggle

**As a user**, I want to see on a person's page which of their action items became real tasks and where those tasks stand, without leaving the drawer.

**Acceptance criteria:**
- Below the "Action items pending review" section in `People.tsx`, add a new section titled **"Active action items"**.
- Renders `person.activeActionItems` (from US-001): each row shows title, owner, due date, status badge (e.g., `todo`, `inProgress`), and `from {meeting title}` as a subtle secondary line.
- Clicking an active row opens the underlying Task in the sidebar / detail view (reuse existing task detail drawer from MyTasks if accessible; otherwise a minimal read-only popover is acceptable for this round).
- Below that, a collapsed section labeled **Show N completed** (where N = `person.doneActionItems.length`). If N === 0, hide the toggle entirely.
- Clicking the toggle expands a list of done items: strikethrough title, dim gray, with the completion date. Click to re-open the task.
- Empty state for Active section: "No active action items for this person." — only show when `activeActionItems.length === 0 && doneActionItems.length === 0`; otherwise just render nothing above the Show-N-completed toggle.
- Typecheck passes.
- Verify in browser using dev-browser skill: after running the seeded demo data (US-005 below) and converting a few action items, the Person drawer shows all three tiers (pending, active, done).

---

### US-005 — Seed demo data exercises the full lifecycle

**As a demo user**, the seeded demo data should include action items in each state (pending, active, done) so the three sections on the Person drawer are visibly populated.

**Acceptance criteria:**
- In the existing `ipcMain.handle('seed:demo', ...)` in `src/main/main.ts`, after creating meetings and their insights, programmatically:
  - Mark 2 action items across different meetings as `convertedToTaskId` set + linked Task in status `todo` or `inProgress`.
  - Mark 2 action items as converted + linked Task status `completed`.
  - Leave the rest (3-4) in the default pending state.
  - Mark 1 action item as `dismissed: true` so we can visually confirm it doesn't appear anywhere by default.
- Use the new `convertActionItemToTask` helper (not a raw DB write) to exercise the real code path.
- Update the seed completion log + return value to reflect the new counts.
- Typecheck passes.
- Verify in browser using dev-browser skill: reset profile, run seed, open any Person drawer that has 2+ meetings → confirm all three sections populated with realistic data.

---

## Rollout

- One branch: `ralph/action-item-lifecycle`.
- Additive schema changes only. Existing action items without the new fields treat absent as `convertedToTaskId: null, dismissed: false` — fully backwards compatible.
- No migration needed.

## Success signal

- Clicking the `+` button on a pending action item → item immediately disappears from "Action items pending review" and reappears in "Active action items" on the next refresh, with the current task status badge.
- Clicking the `×` button → item disappears from pending with an Undo toast; Undo within 5s restores it.
- Demo data populates all three sections visibly.
- No loss of existing functionality: the task still gets created, still appears in MyTasks, still pushes to Jira if auto-push is on.

## Open design questions (out-of-scope)

- Should rejected items also be visible under a separate "Rejected" collapsed section for recovery outside the 5s undo window? (Deferred.)
- Should the Reject button require a reason dropdown ("not relevant", "duplicate", "done already")? (Deferred — capture as optional signal later.)
