# Ollie moments: proactive tray and notifications

Approved mockup: https://claude.ai/artifact/CWFetiZ2Ui84eWK2isGoaw (v3). Visual contract: `docs/OWL_DESIGN.md`.

Proactive means: anticipate what the user is about to walk into and prepare them for it. Everything the app already computes in the background lands in one of four moments. Each moment is at most one OS notification (if the user wants it) and one Ollie card in the tray.

Keep the existing Meetings / Tasks / People tabs, date strip, header "N to review" pill, recorder and all existing behaviour. Use real stored values only; when a section has no data it is omitted, and when a card has nothing at all it does not render.

## The Ollie card

One card under the date strip on the Meetings tab (it replaces the current dismissible "today's brief" card). Styling: background `#f5f9f8`, border `#d3e6df`, 8px radius; kicker in uppercase teal, title 15px deep teal; inner rows are white with thin borders; warning lines use a light orange tint. The card shows exactly one moment, chosen by priority:

1. **Prep** (from 10 min before a meeting until it starts, lead time configurable) — wins over everything.
2. **Wrap-up** (from 5 min after the day's last calendar meeting ends until the next morning card).
3. **Morning** (from the first open of the day until the wrap-up). On the first day back after a gap, the welcome-back content replaces the morning content.

Dismissing (×) hides the card until the next moment begins. Dismissal is stored per moment key (e.g. `prep:<eventId>`, `wrap:<dateKey>`, `morning:<dateKey>`).

### Morning (Day begins)
- Kicker "Ollie planned your day", title "Good morning, <first name>", subtitle counts: meetings · priorities · overdue promises.
- **Top priorities**: top 3 scored tasks (existing daily briefing), numbered, with due/overdue chip and source meeting.
- **Done since yesterday**: tasks auto-completed by task-completion inference since the previous local day start, each with **Undo** (reopens the task).
- **Catch up**: people not met in ≥ 21 days who are waiting on the user (an open commitment by the user to that person, or an open task linked to them). Max 2. Row opens the person.
- **Your Jira** (when Jira is connected and the pull cache has something): an orange line when the active sprint ends within a day with your open tickets ("Sprint 12 ends today at 17:00 with 2 open tickets of yours."), then up to 6 rows: overdue, due today, unanswered @mentions (a mention of you newer than your last comment on that ticket), then the sprint's other open tickets. Tap opens the issue.
- Daily plan window behaviour is unchanged.

### Prep (Before a meeting)
- Trigger: exact timer per upcoming calendar event (not only the 5-minute poll) at `start - leadMinutes`. Skip cancelled events; if an event is cancelled after the card appears, remove the card.
- Kicker "Up next · HH:MM, in N min", title = meeting title, subtitle "Last met <date> · <last meeting title>" when there is a previous meeting with these attendees.
- **Ollie's draft agenda**: existing draft agenda for the event if present.
- **<Name> owes you**: open commitments/tasks owned by an attendee that the user is waiting on, with "N days late" chip when past due.
- **You owe <Name>**: open commitments/tasks owned by the user tied to those attendees, with Overdue chip.
- **Their Jira**: up to 4 ticket rows for the attendees, in this order: their tickets that are blocked (status says blocked, with days blocked, or an open "is blocked by" link), your open tickets that involve them (they reported it or commented), their tickets whose status changed since you last met ("Moved from In Review to QA since you last met", from the changelog; the status-category time when the changelog is unavailable), their open tickets with no update for 7+ days. Attendees linked to a Jira account match by accountId. Tap opens the issue.
- **Waiting on your OK**: pending Jira approvals (`sor-pending-approvals`) whose source meeting included any of these attendees. Approve / Skip.
- Buttons: **Record when it starts** (arms auto-start for that event), **Copy agenda**.
- During the meeting the card stays, with kicker "Now · HH:MM to HH:MM". The record button becomes **Recording** while one runs, **Record now** if the meeting has not been recorded, and disappears once it has.
- Notification: title "<Meeting> in N min", body leads with the most important owed item, then "N Jira update(s) need your OK". Actions: Open prep, Record at start. Replaces the old "Meeting starting soon — don't forget to record" notification.

### Processed (After a meeting)
- Trigger: a meeting's transcript finishes processing (recorded, Zoom, Teams, Meet).
- Inline recap card on that meeting's row in Meetings (the old separate Review page entry point remains reachable but the card is primary).
- Contents: kicker "Processed · HH:MM–HH:MM"; "Inwise found N tasks and N decision(s)"; **patchy-audio warning** when transcription quality flags a stretch; **Tasks found** with Keep / Skip; possible duplicates with Merge / Keep both; **Decision(s)**; **Jira from this meeting**; buttons **Post recap to #<channel>** (reuses existing Slack recap send, only when Slack is connected) and Open meeting.
- **Jira from this meeting**: a receipt line for writes already applied (keys link to Jira), an orange line per failed write with its reason ("PILOT-42 has no transition to Done"), and one row per change waiting for an OK. Rows read as questions: "Move PILOT-42 to Done?" (someone said it is done), "Move the due date on PILOT-42 to 2026-11-04?" (it slipped), "Add the decision to PILOT-42 as a comment?", "Create ticket “…”?" (new work), "Update PILOT-42 instead?" (Inwise thinks the work already has a ticket). It also offers "Assign PILOT-40 to Jordan Lee?", "Mark PILOT-33 as blocked by OPS-12?" and "Add PILOT-41 to Sprint 14?". Each row shows the target key and title and the quote behind it, with Approve / Skip, plus Create new on suggestions. A row that cannot go through yet shows the reason in orange: an assignee not linked to Jira gets **Find in Jira** (search by name, pick, then Approve) instead of Approve; a missing sprint gets only Skip. Dates read like "Wed, Nov 4". All of it goes through the Jira gate (docs/JIRA_SAFETY.md).
- **Failure**: if processing failed but audio is saved, an orange "Needs a retry" card with **Retry** and **Export audio** (existing recovery actions).
- Notification (one per meeting): title "Inwise processed <Meeting>", body "Found N tasks and N decision(s). Pushed N Jira update(s), N need(s) your OK." Failure variant: "Couldn't process <Meeting>. The audio is saved." This replaces the separate "Zoom transcript imported", "N updates pushed to Jira" and "Transcription failed" notifications.

### Wrap-up (End of day)
- Trigger: 5 minutes after the end of the last calendar meeting of the local day (re-evaluated when the calendar changes). Fires once per day. If a recording is active, wait until it stops.
- Kicker "Day wrapped", title "Ready for tomorrow, <first name>", subtitle today's counts: meetings · tasks found · decisions.
- **Tomorrow**: first meeting tomorrow with "Agenda drafted · N task(s) due before it"; overdue items involving tomorrow's attendees; **crunch** warning when tomorrow has no free gap ≥ 30 min between 9:00 and 17:00 (or between first and last meeting): "No free time from X to Y tomorrow." plus the top overdue task to do tonight or move; **cancelled** lines for meetings cancelled today whose linked tasks had due dates tied to them.
- **Gone quiet**: open tasks with priority score ≥ 60 that have not been mentioned in any meeting or Slack message and not updated for ≥ 7 days; boost those that are commitments to another person. Max 3. Action: **Add to tomorrow** (sets due date to tomorrow).
- **Came in from Slack**: today's ingested Slack threads grouped by channel with counts and tasks/decisions found.
- **Cleaned up**: tasks snoozed by the staleness sweep today, with **Undo**; receipts from the action-execution log (work done by Claude/Codex/OpenWorker today).
- **Still needs a retry**: meetings with saved audio not yet processed.
- **Jira today**: what Inwise changed in Jira today from meetings (write log: created, moved, due date, commented), a row "N Jira changes are waiting for your OK" with Open review, and tickets discussed today (keys in today's items, intents, decisions, linked tasks, or writes) that have had no Jira update for 7+ days.
- Footer line in the tray: "Slack synced N min ago" when Slack is connected.
- Notification: title "Tomorrow starts at HH:MM with <Meeting>" (or "Day wrapped" if nothing tomorrow), body "Today: N meetings, N tasks found. Slack brought in N threads. N Jira changes wait for your OK." Actions: See wrap-up, Dismiss.

Jira adds no notifications of its own. The prep body mentions a blocked ticket ("Priya's PILOT-1 is blocked.") only when it has no owed item to lead with; the processed and wrap bodies count Jira changes waiting for an OK. Loudness follows Settings > Notifications as before.

### People tab
- A small teal note under a person's row when they are in the Catch up set: "N weeks since you met · waiting on <thing>".
- When Jira is connected and Inwise could not match a person to a Jira account by email: "Not linked to Jira yet" with **Find in Jira** (search by name, pick one; stored on the person). The person page shows "Linked to Jira as <name>" with **Unlink**.

## Notifications

- Recording problems always notify (mic lost, other speaker audio, are you still there, meeting conflict). Unchanged.
- Nothing from the four moments shows while a meeting is in progress or a recording is active; it is queued and shown when that ends (except prep, which is by definition before).
- One notification per moment instance.
- Notification styling uses the OS; clicking it opens the tray to the relevant card.

## Settings · Notifications

New section in tray Settings:
- Morning plan: Window / Tray only / Off (Window = current daily plan window behaviour).
- Before a meeting: 5 / 10 / 15 min, Tray only, Off.
- After a meeting: Notify / Tray only / Off.
- End of day: Notify / Tray only / Off.
- Recording problems: Always on (not editable).

Defaults: Window, 10 min, Notify, Notify.

## Not in scope
Pill docking into the tray, tray icon red dot, meetings-with-no-agenda nudges, weekly review, any new cloud dependency.

## Verification
- Unit tests for every pure compute function (moment selection, prep content, owes split, processed summary, wrap-up, gone quiet, catch up, crunch, notification copy, settings defaults/migration).
- `npm test` passes. Typecheck/build passes.
- `npx electron scripts/test-design-ui.cjs` extended to capture the four card states, the failure card, People tab note and Notifications settings with synthetic storage.

## IPC contract

The main-process half is built. Payload types live in `src/main/ollie-moments-types.ts` (import-free) and are re-exported from `src/renderer/api.ts`, so components can `import type { OllieMoment } from '../api'`. Timestamps are epoch ms unless noted; `dueDate` / `date` strings are passed through as stored (`YYYY-MM-DD` or ISO).

### Calls (`api.*` → channel)

| api method | channel | returns |
|---|---|---|
| `getOllieMoment()` | `ollie:getMoment` | `OllieMoment \| null`: the one card under the date strip. `null` means render nothing (dismissed, or the setting is Off). |
| `dismissOllieMoment(key)` | `ollie:dismiss` | `true`. Stores `key` (`prep:<eventId>`, `wrap:<YYYY-MM-DD>`, `morning:<YYYY-MM-DD>`). Dismissing `morning:*` also marks welcome-back seen. Emits `ollie:moment-changed {reason:'dismissed'}`. |
| `getOllieProcessed(meetingId)` | `ollie:getProcessed` | `ProcessedContent \| null`: inline recap for a meeting row. Works any time after processing, not only right after. |
| `getOllieCatchUpNotes()` | `ollie:catchUpNotes` | `CatchUpNote[]`: People tab notes, the same set as the morning Catch up (max 2). `text` is ready to render. |
| `ollieSetRecordAtStart(eventId, armed)` | `ollie:setRecordAtStart` | `{ armed }`. When armed, recording starts at the event's start time through the normal meeting-starting path (no-op if that event is already recording). Session-only. |
| `ollieAddToTomorrow(taskId)` | `ollie:addToTomorrow` | updated task; `dueDate` becomes tomorrow's `YYYY-MM-DD`. |
| `jiraGetWriteMode()` | `jira:getWriteMode` | `{ mode: 'ask' \| 'auto'; threshold: 0.9 }` (Settings > Jira > Jira changes) |
| `jiraSetWriteMode(mode)` | `jira:setWriteMode` | same shape, after saving |
| `jiraCreateInstead(id)` | `jira:createInstead` | `{ ok, key?, error? }`. Skips the held suggestion `id` and creates a new ticket for its task (a click). |
| `jiraPullNow()` | `jira:pullNow` | pull summary; the scheduled pull runs at launch and every 30 min |
| `jiraSearchUsers(query)` | `jira:searchUsers` | `{ ok, users?: { accountId, displayName, email }[], error? }` |
| `jiraResolveAssignee(id, user)` | `jira:resolveAssignee` | `{ ok, error? }`. Fills the account on a held assign row and stores it on the person. The row still needs Approve. |
| `peopleSetJiraAccount(personId, user)` / `peopleUnlinkJira(personId)` | `people:setJiraAccount` / `people:unlinkJira` | `{ ok, person }`. `person.jiraLink = { status: 'linked' \| 'email' \| 'unresolved' \| 'unlinked', accountId, displayName, checkedAt }` |
| `getNotificationSettings()` | `notifications:get` | `NotificationSettings` |
| `setNotificationSettings(patch)` | `notifications:set` | normalized `NotificationSettings`. The patch may be partial and `prep` merges (e.g. `{prep:{mode:'tray'}}`). Invalid values fall back to defaults. |

Card actions that reuse existing calls:

| Card action | Existing api |
|---|---|
| Morning · Done since yesterday · Undo | `rejectLikelyDone(taskId)` (clears the inference flag; the task was never closed, see gaps) |
| Wrap-up · Cleaned up · Undo | `bringBackTask(taskId)` |
| Waiting on your OK · Approve / Skip (prep and recap Jira rows) | `sorApprove(id)` / `sorReject(id)` with `PendingJiraApproval.id`. Approve returns `{ ok:false, error }` when Jira refuses (shown under the row). |
| Jira ticket rows (Their Jira, Your Jira, Jira today) | `openExternal(row.url)` |
| Jira today · Open review | navigation to Review, approvals |
| Processed · Tasks found · Keep / Skip | `updateTask(taskId, { approval: { status: 'approved' } })` / `{ status: 'rejected' }` (as ReviewPage does) |
| Processed · duplicate · Merge / Keep both | `dedupResolvePending(taskId, 'same')` / `dedupResolvePending(taskId, 'new')` |
| Needs a retry · Retry / Export audio | `retryRecording(meetingId)` / `exportRecording(meetingId)` |
| Post recap to #channel | `slackListWriteChannels()` + `slackPostOllieNote(channelId, note)` (see `popup/slack-recap.ts`); show only when `slackConnected` |
| Copy agenda | renderer clipboard from `prep.draftAgenda` |
| Rows that open a person / meeting / task | existing navigation with `personId` / `meetingId` / `taskId` |

### Events (`api.on(channel, cb)`)

- `ollie:moment-changed` → `OllieMomentChanged { reason, meetingId? }`. Refetch `getOllieMoment()`. When `reason === 'processed'`, also refetch `getOllieProcessed(meetingId)` for that row. Reasons: `calendar`, `prep-start`, `meeting-start`, `meeting-end`, `wrap`, `processed`, `dismissed`, `settings`, `action`, `day-change`.
- `ollie:focus-moment` → `OllieFocusMoment { kind: 'prep' | 'wrap' | 'morning' | 'processed', key, meetingId?, eventId? }`. Sent after a notification click; the popup is already shown. Switch to the Meetings tab and scroll to the card, or to the meeting row for `processed`.

### Payloads

```ts
type NotificationSettings = {
  morning: 'window' | 'tray' | 'off';                                   // default 'window'
  prep: { mode: 'notify' | 'tray' | 'off'; leadMinutes: 5 | 10 | 15 };  // default notify, 10
  processed: 'notify' | 'tray' | 'off';                                 // default 'notify'
  wrapUp: 'notify' | 'tray' | 'off';                                    // default 'notify'
  recordingProblems: true;                                              // always on; render locked
};
// "Before a meeting: 5 / 10 / 15 min, Tray only, Off" maps to
// 5/10/15 -> {mode:'notify', leadMinutes}, Tray only -> {mode:'tray'}, Off -> {mode:'off'}.
// Existing installs that had the daily plan window off migrate to morning:'tray'.

type OllieMoment =
  | { kind: 'prep';    key: string; generatedAt: number; prep: PrepContent }
  | { kind: 'wrap';    key: string; generatedAt: number; wrapUp: WrapUpContent }
  | { kind: 'morning'; key: string; generatedAt: number; morning: MorningContent };

type TaskRef = { taskId: string; title: string; dueDate: string | null; daysLate: number | null }; // daysLate >= 1 or null

type MorningContent = {
  firstName: string;            // '' when no user name is set
  meetingCount: number; priorityCount: number; overduePromiseCount: number; // subtitle counts
  topPriorities: (TaskRef & { rank: number; score: number; sourceMeetingId: string | null; sourceMeetingTitle: string | null })[]; // max 3
  doneSinceYesterday: TaskRef[]; // flagged by completion inference since the previous local day start
  catchUp: { personId: string; name: string; daysSinceMet: number; weeksSinceMet: number; waitingOn: string; waitingCount: number }[]; // max 2
  welcomeBack: null | { gapDays: number; wins: { cleared?; jiraProgress?; meetingsMatched?; calendarHealthy? }; ask?: { kind; payload } };
  // non-null welcomeBack: render the welcome-back content instead of the morning sections
};

type PrepContent = {
  eventId: string; title: string; startTime: number; endTime: number; minutesUntil: number;
  attendees: string[];                                         // display names, self removed
  lastMet: { meetingId: string; title: string; date: string } | null; // "Last met <date> · <title>"
  draftAgenda: string[] | null;                                // see data gaps
  owes: { name: string; personId: string | null; owesYou: OwedItem[]; youOwe: OwedItem[] }[]; // max 3 each; attendees with items only
  pendingApprovals: PendingJiraApproval[];                     // from meetings these attendees attended
  recordArmed: boolean;
};
type OwedItem = { kind: 'task' | 'commitment'; taskId: string | null; meetingId: string | null; text: string; dueDate: string | null; daysLate: number | null };
// owesYou with daysLate -> "N days late" chip; youOwe with daysLate -> "Overdue" chip
type PendingJiraApproval = {
  id: string; operation: 'create' | 'update' | 'transition' | 'comment' | 'assign' | 'link' | 'sprint';
  summary: string;               // a question: "Move PILOT-42 to Done?", or the suggestion text
  issueKey: string | null; issueTitle: string | null; url: string | null;
  evidence: string | null;       // quote from the meeting
  suggestion: string | null;     // "Update PILOT-42 instead?" -> also offer Create new
  intent: string | null;         // done | due_moved | decision | new | reassign | blocked_by | sprint
  blockedReason: string | null;  // why it cannot be approved yet; hide Approve
  needs: 'jira-user' | null;     // show Find in Jira (jiraSearchUsers + jiraResolveAssignee)
  assigneeName: string | null;   // assign rows: the name to search for
  confidence: number | null;
  meetingId: string | null; meetingTitle: string | null; createdAt: string;
};

type JiraTicketRow = { key: string; title: string; url: string | null; detail: string; owner: string | null;
  kind: 'blocked' | 'moved' | 'stale' | 'yours' | 'due_today' | 'overdue' | 'sprint' | 'mention' };
// PrepContent.jira:    null | { rows: JiraTicketRow[] }                                   // max 4
// MorningContent.jira: null | { dueToday; overdue; mentions: JiraTicketRow[];             // max 3 each
//                              sprintEnding: null | { name; endsAt; openCount; rows } }
// WrapUpContent.jira:  null | { changedToday: { id; issueKey; url; operation; summary }[]; waitingCount: number; staleDiscussed: JiraTicketRow[] }
// ProcessedContent.jira gains failed: { id; issueKey; operation; message }[]
// Each is null when Jira is not connected or there is nothing to show.

type ProcessedContent = {
  meetingId: string; title: string; source: string; status: 'processed' | 'needs_review' | 'failed';
  startedAt: number | null; endedAt: number | null;            // "Processed · HH:MM–HH:MM"; endedAt null when duration unknown
  taskCount: number; decisionCount: number;
  tasks: { taskId: string; title: string; owner: string | null; dueDate: string | null;
           approvalStatus: string;                              // 'pending' -> Keep / Skip
           duplicateOf: { taskId: string; title: string; wasDone: boolean } | null }[]; // -> Merge / Keep both
  decisions: string[];
  patchyAudio: { reasons: string[] } | null;                   // orange warning line
  jira: null | { pushedCount: number; failedCount: number; pushed: { id: string; issueKey: string; url: string | null; operation: string }[]; pending: PendingJiraApproval[] };
  failure: null | { message: string; stage: string | null; audioSaved: boolean }; // status 'failed' -> "Needs a retry" card
  slackConnected: boolean;
};

type WrapUpContent = {
  firstName: string;
  today: { meetingCount: number; tasksFound: number; decisions: number };
  tomorrow: {
    firstMeeting: null | { eventId: string; title: string; startTime: number; agendaDrafted: boolean; tasksDueBefore: TaskRef[] };
    overdueWithAttendees: (TaskRef & { attendee: string })[];  // max 3
    crunch: null | { from: number; to: number; topOverdue: TaskRef | null }; // "No free time from X to Y tomorrow."
    cancelledToday: { eventId: string; title: string; startTime: number; tasks: TaskRef[] }[];
  };
  goneQuiet: (TaskRef & { score: number; commitmentToOther: boolean; lastActivityAt: string | null })[]; // max 3 -> Add to tomorrow
  slackToday: { channelId: string; threadCount: number; taskCount: number; decisionCount: number }[]; // name via slackListChannels()
  snoozedToday: TaskRef[];                                     // Undo -> bringBackTask
  receipts: { executionId: string; title: string; client: string; status: string; summary: string | null; at: string }[];
  needsRetry: { meetingId: string; title: string; date: string; message: string | null }[]; // max 3
  slackSyncedAt: number | null;                                // footer "Slack synced N min ago"; null = hide
};

type CatchUpNote = { personId: string; weeksSinceMet: number; waitingOn: string; text: string };
```

### Behaviour the UI can rely on

- Sections with no data come back as empty arrays or `null`; omit them. Nothing is synthesized.
- Selection: prep (from `start - leadMinutes` until the meeting ends, so the tray keeps showing the meeting you are in; an upcoming meeting outranks one running over) > wrap-up (from the last meeting's end + 5 min; not while recording) > morning. Dismissal hides the card until the next moment begins and never promotes a lower moment.
- Notifications are main-process only (prep, processed, wrap-up; morning has none). Moment notifications wait while a meeting or recording is active; prep is never held. Recording-problem notifications are unchanged.
- `briefing:get` and the daily plan window are unchanged; the Ollie card can replace the dismissible "today's brief" card.

### Data gaps

- **Jira sections** read the local pull cache (`jira-issues.db`, refreshed every 30 min), so they can be up to 30 minutes behind Jira. "Moved since you last met" uses the status category change time, not the full changelog. Attendees are matched to Jira accounts by email; sites that hide emails leave "Their Jira" empty for those people.

- **Done since yesterday**: task-completion inference never closes tasks; it flags `likelyDone`. The section lists tasks flagged since the previous day (new `likelyDoneAt` timestamp, so flags made before this change do not appear). Undo clears the flag.
- **Draft agenda**: agendas are not stored per event. Prep shows the agenda the daily plan drafted for that event earlier in the same app session (recurring meetings with history, API key set); otherwise `null`. `agendaDrafted` in wrap-up uses the same source.
- **Slack channel**: threads imported from now on carry `slackChannelId`; older threads group under `'unknown'`. The poller passes the channel id, not a name.
- **Cancelled today**: the calendar feed drops cancelled events, so a cancellation is inferred when a today-event disappears between two healthy refreshes (first refresh after launch establishes the baseline).
- **Record at start** arming and the Slack last-sync time are in memory (reset on restart).
