# inwise-opensource — Welcome-Back Screen & Task Lifecycle

## Context

Users come back to the app after gaps (days, weeks, months). Today they return to a static pile of whatever state they left — no signal of what the app did on their behalf, no reconciliation of tasks that went stale, no re-orientation. The pile feels like homework.

This PRD reframes the return experience around a single principle: **lead with what the app did for the user, not what the user didn't do.** Returning users should feel helped, not nagged. A user on the edge of churning does not need more homework.

Scope: **desktop (inwise-opensource) only.** Web-app counterpart is out of scope for this round.

## Goals

- Surface a ranked, compact "welcome back" view on re-open after a meaningful gap (default: 2+ days since `lastOpenedAt`).
- Lead with wins (what the app did), surface at most **one** ask per return, treat "nothing urgent" as a valid, trust-building outcome.
- Auto-snooze stale tasks (no touch in 30d, no recent mentions) with one-click reversibility; nothing is deleted, nothing is irreversible.
- Flag tasks as *likely-done* when transcripts imply completion, but never auto-complete without user confirmation.
- Suppress the welcome-back screen when context overrides ceremony — e.g., the user is currently in a calendar-scheduled meeting.

## Non-goals

- Web-app welcome-back (tracked separately).
- Adaptive learning of snooze thresholds from user overrides (post-v1).
- A "full activity timeline" view (the chips/escape hatches point at existing views instead).
- Any change to the post-meeting transcription / insights pipeline beyond a single additional inference pass.

## Success signal

- After 3 weeks away with 40 active tasks, the user sees one screen in under 10 seconds: "Cleared N tasks, M Jira stories progressed, K calendar events this week" + at most one ask. Not a scroll.
- After 9 days away with zero meaningful change, the user sees "Nothing urgent while you were out — everything's where you left it." and one click gets them back to Home.
- Auto-snoozed tasks are one click to restore, visible in a Tasks filter, and never silently dropped.
- During an in-progress calendar meeting, the welcome-back screen does NOT appear — a small "start recording?" banner is offered instead.

---

## User Stories

### US-001 — Persist lastOpenedAt and welcomeBackLastSeenAt

**As a developer**, I need two timestamps tracked in config so the rest of the welcome-back logic has a reliable "gap since last open" and "last time we showed the banner" signal.

**Acceptance criteria:**
- Extend `Config` in `src/main/config.ts` with `lastOpenedAt: string | null` and `welcomeBackLastSeenAt: string | null`; defaults null.
- Update `lastOpenedAt` to `new Date().toISOString()` in both: (a) `mainWindow.on('ready-to-show')` (first open) and (b) `mainWindow.on('show')` (tray → show re-open).
- Export helper `getDaysSinceLastOpen(): number | null` that returns the gap in days (or null if `lastOpenedAt` is null, i.e., first ever launch).
- Export helper `markWelcomeBackSeen(): void` that writes `welcomeBackLastSeenAt = now`.
- On fresh install (no prior `lastOpenedAt`), welcome-back logic treats this as first-ever open (handled in US-004 by returning null).
- Typecheck passes.

---

### US-002 — Task snooze schema and helpers

**As a developer**, I need task records to support a soft "snoozed" state with full reversibility, so the staleness sweep in US-003 and the filter UI in US-006 have a stable substrate.

**Acceptance criteria:**
- Extend task records in `src/main/database.ts` with three new fields: `snoozedAt: string | null`, `snoozedReason: string | null` (e.g., `'stale-30d'`, `'user-manual'`), `lastMentionedAt: string | null`.
- Add helpers: `snoozeTask(taskId: string, reason: string): Promise<void>`, `bringBackTask(taskId: string): Promise<void>` (clears snoozedAt + snoozedReason and bumps updatedAt), `getSnoozedTasks(): Promise<Task[]>`, `touchLastMentioned(taskId: string, when: string): Promise<void>`.
- Modify existing `getTasks()` to filter out snoozed tasks by default. Add an optional `getTasks({ includeSnoozed: true })` overload.
- Add `isSnoozed(t: Task): boolean` utility.
- Typecheck passes.
- Tests pass: unit tests for snooze → getTasks excludes it; bringBack → reappears; touchLastMentioned updates the field; getSnoozedTasks returns only snoozed.

---

### US-003 — Staleness sweep service

**As a user**, when I come back after a long gap, I want the app to have quietly cleared tasks that clearly aren't relevant anymore (no activity, no one mentioning them), so my active list isn't cluttered with ghosts.

**Acceptance criteria:**
- New module `src/main/staleness-sweep.ts` exporting `sweepStaleTasks(): Promise<{ snoozed: Task[] }>`.
- Sweep criteria: task is eligible for auto-snooze if ALL of:
  - `status === 'active'`
  - `!isSnoozed(t)` (don't re-snooze)
  - `updatedAt < now - 30 days`
  - `!lastMentionedAt || lastMentionedAt < now - 14 days`
  - `priority !== 'high'` (never auto-snooze high-priority tasks)
- For each eligible task, call `snoozeTask(t.id, 'stale-30d')`.
- Return `{ snoozed: [...the just-snoozed tasks...] }`.
- Called from `app.whenReady()` AFTER calendar sync completes; non-blocking (no await inside whenReady).
- Result stashed on a module-local variable `lastSweepResult` with timestamp so US-004 can read it without re-running the sweep on every welcome-back compute.
- Log line: `staleness-sweep | snoozed=N eligible=E of total active tasks=T`.
- Typecheck passes.
- Tests pass: unit tests for each criterion (age gate, mention gate, priority gate, already-snoozed gate).

---

### US-004 — Welcome-back compute backend

**As a developer**, I need one IPC that returns the entire ranked bucket list for the welcome-back screen in one shot, so the UI component is presentation-only and testable against fixtures.

**Acceptance criteria:**
- New IPC `welcomeBack:compute` in `src/main/main.ts` returns either `null` (when welcome-back should not show) or an object:
```
{
  gapDays: number,
  wins: {
    cleared?: { count: number, sampleTitles: string[] },
    jiraProgress?: { count: number, doneCount: number },
    meetingsMatched?: { count: number },
    calendarHealthy?: { upcomingCount: number }
  },
  ask?: {
    kind: 'contradiction' | 'overdueWithSignal' | 'launchAtStartupOffer',
    payload: <kind-specific>
  }
}
```
- Returns `null` if `getDaysSinceLastOpen() < 2` OR `welcomeBackLastSeenAt >= lastOpenedAt` (already dismissed since last open).
- `wins.cleared` draws from `lastSweepResult` (US-003).
- `wins.jiraProgress` counts Jira stories whose `status` changed to `Done` or forward in the gap window (use existing jira-client state cache).
- `wins.meetingsMatched` counts meetings that got automatically linked to Jira issues in the gap (from the existing pipeline:jira-auto-push logs or the task records).
- `wins.calendarHealthy` — upcoming event count for the next 7 days from `calendarWatcher.getUpcomingEvents()`.
- `ask` is chosen as the single most important item, in this priority order:
  1. An unresolved contradiction surfaced by `detectContradictions` where `createdAt > lastOpenedAt` → `kind: 'contradiction'`.
  2. An overdue task that was mentioned in a meeting within the last 14 days → `kind: 'overdueWithSignal'`, payload includes the task.
  3. Missed meetings + `openAtLogin` is false + gap >= 3 days + missedCount >= 3 → `kind: 'launchAtStartupOffer'`, payload includes `missedCount`.
- If no ask qualifies, `ask` is omitted (scenario 5: "nothing urgent").
- Expose `markWelcomeBackSeen` via IPC `welcomeBack:dismiss` for the UI to call on close.
- Typecheck passes.
- Tests pass: unit tests for the four ask-selection branches + the null-return conditions.

---

### US-005 — Welcome-back UI component

**As a user**, after returning from a gap, I want one scannable screen that shows what the app did for me, with at most one thing I need to act on, phrased as help rather than homework.

**Acceptance criteria:**
- New component `src/renderer/WelcomeBack.tsx` rendered conditionally from `App.tsx` on app start.
- On mount: call `inwiseAPI.welcomeBackCompute()`. If it returns non-null, render; else null.
- Copy rules — helper voice, count-not-list:
  - `wins.cleared` → "Cleared **N tasks** you hadn't touched recently (bring any back anytime)"
  - `wins.jiraProgress` → "**N Jira stories** moved forward while you were out — M are now Done"
  - `wins.meetingsMatched` → "Matched N new meetings to Jira issues automatically"
  - `wins.calendarHealthy` → "Calendar in sync; N upcoming this week"
- `ask.contradiction` → renders a one-line call-out: "One thing worth a look. [brief contradiction summary]. `[Review]` `[Dismiss]`"
- `ask.overdueWithSignal` → "One task is past due and you've mentioned it recently: `{title}`. `[Snooze to next week]` `[Mark done]` `[Keep as-is]`"
- `ask.launchAtStartupOffer` → "Want Inwise to start automatically when you log in? You missed a few meetings while it was closed. `[Turn on]` `[Not now]`"
- If `ask` is absent: render a single line "Nothing urgent while you were out — everything's where you left it."
- Chip row at bottom: `Tasks` `Meetings` `Jira` `Calendar` — each navigates to the respective view.
- `[Done]` button top-right → calls `inwiseAPI.welcomeBackDismiss()` and removes the component from the DOM.
- Never show more than ONE ask. Never show a list of titles (count is the message).
- Typecheck passes.
- Verify in browser using dev-browser skill: launch app with a synthetic `welcomeBack:compute` response covering wins-only; verify copy; trigger a version with `ask.contradiction`; trigger an empty-state; confirm dismiss persists across reopens of main window.

---

### US-006 — Snoozed tasks filter + bring-back UI in Tasks view

**As a user**, when I want to review what the app auto-snoozed, I can see those tasks in a filter and bring any back with one click.

**Acceptance criteria:**
- In the Tasks / MyTasks view (`src/renderer/MyTasks.tsx` or equivalent), add a filter tab/pill labeled `Snoozed` next to existing filters.
- Selecting Snoozed calls `inwiseAPI.getSnoozedTasks()` (new IPC wrapper around `getSnoozedTasks()`) and renders those tasks with:
  - Title, original due date (if any), `snoozedAt`, `snoozedReason` in human form (e.g., "auto-snoozed — no activity for 30+ days")
  - `[Bring back]` button per row
- `[Bring back all]` button at the top of the list when on the Snoozed filter.
- Clicking Bring Back calls `inwiseAPI.bringBackTask(id)` → task flips to active and disappears from the Snoozed filter; active-list re-renders.
- After bringing back a task, show a subtle inline confirmation for 3s: "Brought back — back in your active list."
- Badge on the Snoozed filter pill shows the count when > 0.
- Typecheck passes.
- Verify in browser using dev-browser skill: with seeded snoozed tasks, navigate to Snoozed filter; bring one back, confirm it disappears from filter and appears in Active; bring back all; confirm count-zero state.

---

### US-007 — Task completion inference from transcripts

**As a user**, after a meeting is transcribed, I want the app to flag tasks it thinks I completed (based on what I said), so I can confirm with one click — but it never auto-closes a task.

**Acceptance criteria:**
- In the post-meeting pipeline (inside `runRecordingPipeline` in `src/main/main.ts`, after `saveInsights` and before `pipeline:done`), add a new step `inferCompletedTasks(transcript, openTasks)`.
- The step takes (a) the meeting transcript and (b) the user's currently-active, non-snoozed tasks, and makes one LLM call (using the configured `apiProvider`) that returns the list of task IDs whose completion the transcript strongly implies.
- Model prompt should require high confidence — prefer false negatives over false positives.
- For each returned task ID, set `likelyDone: true` on the task (new field; extend schema).
- Do NOT set `status: 'done'` automatically.
- Log: `pipeline:likely-done | flagged=N tasks`.
- In the Tasks view, tasks with `likelyDone === true` render a small "Done?" pill next to the title with `[Yes]` `[No]` inline actions. `Yes` → `status: 'done'`, clears `likelyDone`. `No` → clears `likelyDone`, `updatedAt` ticks forward.
- Only evaluate transcripts within 24h of their creation (don't retroactively re-infer on old ones).
- Typecheck passes.
- Tests pass: unit test for the inference call with mocked LLM responses covering (a) empty list (no matches), (b) single match, (c) multiple matches. Plus a UI test that renders the pill when `likelyDone === true`.

---

### US-008 — Live-meeting suppression + "start recording?" banner

**As a user**, if I open the app while I'm currently in a scheduled meeting, I want the app to offer to start recording instead of dumping me into a retrospective welcome screen.

**Acceptance criteria:**
- On app show, BEFORE rendering `WelcomeBack`, check `calendarWatcher.getUpcomingEvents()` for an event where `startTime <= now <= (endTime || startTime + 90min)` AND no recording is currently active (`!isRecordingActive` and no `overlayWindow`).
- If such an event exists, suppress `WelcomeBack` for this session AND render a compact banner at the top of Home (`src/renderer/App.tsx` or a new `LiveMeetingBanner.tsx`):
  - "This looks like your meeting with **{attendee or title}** — want me to start recording? `[Start recording]` `[Not now]`"
- `[Start recording]` triggers the existing `recording:start` flow with the event's calendarEventId and title.
- `[Not now]` dismisses the banner for this specific event (store event id in a session-local dismissed set); if the user reopens later in the same event window, don't re-prompt.
- After the banner dismisses or the event ends, `WelcomeBack` becomes eligible again on the NEXT app open (not this one — that would be jarring).
- Typecheck passes.
- Verify in browser using dev-browser skill: inject a synthetic in-progress calendar event via test IPC, confirm banner appears and WelcomeBack is suppressed; click Start, confirm overlay opens; dismiss, confirm banner goes away and doesn't re-appear for that event.

---

### US-009 — Launch-at-startup offer (wired to ask.launchAtStartupOffer)

**As a user**, if I've missed meetings because the app wasn't running, I want a one-tap way to have it launch at login so I don't miss them next time.

**Acceptance criteria:**
- In `WelcomeBack.tsx` (from US-005), the `ask.launchAtStartupOffer` branch renders the offer card described above.
- `[Turn on]` invokes a new IPC `app:setLoginItemOpenAtLogin(true)` which calls Electron's `app.setLoginItemSettings({ openAtLogin: true })`.
- After success, the card morphs to confirm: "Done. Inwise will start automatically next time you log in."
- `[Not now]` dismisses the card only (doesn't mark welcomeBack itself as seen). If the user later hits `[Done]` at top of screen, the whole welcome-back is dismissed; otherwise it stays until they act or dismiss.
- Missed-meeting detection for the compute: calendar events with `startTime > lastOpenedAt && startTime < now` that have no corresponding row in `meetings.db` with status !== 'calendar_sync' (i.e., nothing was actually recorded for them).
- Guard: don't show the offer if `app.getLoginItemSettings().openAtLogin` is already true, regardless of missed-meeting count.
- Typecheck passes.
- Verify in browser using dev-browser skill: with openAtLogin=false and 3+ simulated missed events, confirm offer renders; click Turn on, confirm success state; restart app and confirm openAtLogin=true.

---

## Rollout

- One branch: `ralph/welcome-back-task-lifecycle`.
- All changes local to `inwise-opensource`. No schema migrations beyond additive fields on the Task and Config records.
- Staleness sweep is opt-out-safe: if a user disagrees with auto-snoozes, every one is restorable in one click (US-006).
- No breaking changes to existing IPC or DB collections.

## Open design questions (out-of-scope for this round)

- Adaptive snooze thresholds (learn from "bring back" overrides).
- Welcome-back equivalent for the web app.
- Settings toggle "Always show full activity on return" for power users who want the chore list on purpose.
