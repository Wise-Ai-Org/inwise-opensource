# Test Plan

End-to-end test plan covering all merged work since 2026-04-17. Assumes the app has been rebuilt after the latest merge (`npm run build && npm start`). Organized by user surface — not by PRD round — so you can run through it linearly.

## Prerequisites

- Run `npm run build` first. Everything below depends on the latest compiled `dist/`.
- Keep `%APPDATA%/inwise-opensource/app.log` open in a tail for silent-check verification.
- At least one existing voiceprint in `voiceprints.db` (Shravani Vatti, Zee are there from prior runs).

---

## On app start

- **Fresh open, no gap > 2 days** → Home view renders, no welcome-back screen.
- **Open after 2+ days away** → Welcome-back screen appears with wins ("Cleared N tasks", "N Jira stories moved forward", "Calendar in sync — N upcoming this week"). At most one `[Review]` / ask visible.
- **Open when nothing meaningful changed** → single line: *"Nothing urgent while you were out — everything's where you left it."* Chip row at bottom to navigate.
- **Open during a live scheduled meeting** → no welcome-back; instead a banner at top of Home: *"This looks like your meeting with X — start recording? [Start] [Not now]"*. Dismiss persists per event-id (won't re-prompt for the same event on another reopen in the same window).
- **`[Done]` on welcome-back** → dismiss persists; reopens of the window in the same session don't re-show.
- **Fresh install (no prior `lastOpenedAt`)** → no welcome-back, no errors (treated as first-ever open).

## Sidebar / Record Meeting pill

- **Amber dot appears** when mic or system audio is unhealthy; hover tooltip explains which side is broken and consequence ("Only your voice will be recorded — other participants won't be transcribed").
- **Dot persists on the "Stop Recording" pill** during an active recording.
- **No dot when both healthy.**
- **Click Record Meeting during a scheduled calendar event** → recording auto-attaches that event's `calendarEventId` (visible in `app.log` as `audio-data:received | calendarEventId=...`). Attendees resolve to the event's list; title auto-fills from the event when you haven't typed one.
- **Click Record Meeting with no active event** → ad-hoc recording works as before (no regression).

## Simultaneous-meeting conflict

- **Two events starting within ~90 seconds** → conflict modal appears listing both with title, start time, attendee count. User picks which to record.
- **30 seconds no response** → auto-pick. Priority: meeting with more attendees matching `selfEmails` / `userName`; tiebreaker = earlier startTime; final tiebreaker = first-fired.
- **Log line** fires: `calendar-watcher:conflict | recording="X" passed-over="Y" reason=auto-selected|user-selected`.
- **Passed-over meeting still appears in upcoming list** — not silently removed from the calendar.

## During a meeting

- **Mic or system audio fails mid-recording** → desktop Notification fires once per failure type (debounced 60s): *"System audio lost — only your mic will be transcribed for the rest of this meeting."*
- **Notification does not fire outside of active recording.**

## After a meeting ends

- **Check `%APPDATA%/inwise-opensource/recordings/`** — the WAV file is still there after the pipeline completes. (Previously was deleted from `%TEMP%`.)
- **Tasks the transcript implies you finished** → "Done?" pill appears next to the task title in the Tasks view with `[Yes]` `[No]`.
  - `[Yes]` → task status flips to `done`, pill clears.
  - `[No]` → `likelyDone` clears, task stays active, `updatedAt` ticks forward.
- **Never auto-completes** — pill is a prompt, not an action.
- **Only evaluates transcripts <24h old** — old recordings reviewed now don't retroactively flag tasks.

## Settings → Calendars

- **Existing Google/Outlook ICS URLs pre-populated** as rows labeled "Google" and "Outlook" after the one-time migration (check: first launch post-upgrade, rows appear automatically).
- **`[+ Add calendar]`** appends a new row; label field auto-focuses.
- **Each row:** label input, provider dropdown (Google/Outlook/Other), URL input, enabled toggle, `[Test]` button, `[Delete]` button.
- **Invalid URL + `[Test]`** → inline error.
- **Valid URL + `[Test]`** → "Connected — N upcoming events".
- **Toggle a calendar off** → events from that calendar disappear from upcoming list after the next poll (~5 min).
- **CalendarStatus at top** aggregates across all enabled calendars (total event count + any-failing flag).
- **Cross-calendar duplicate events** — a meeting on two synced calendars appears once in the upcoming list. Verify via any shared calendar event.

## Settings → Your email addresses (selfEmails)

- **Type email + Enter or comma** → chip added to the list.
- **Invalid email** → inline error for 3s, chip not added.
- **Duplicate email** → silently rejected (no-op, case-insensitive).
- **`×` on a chip** → removes it, persists.
- **Reload Settings** → chips persist.
- **Effect on attendees:** any attendee matching any selfEmail is filtered from attendee lists (voice enrollment, speaker labels). Confirm by recording a meeting where you're listed by an alias email — you should not appear as an "other attendee."

## Settings → Voiceprints

- **Click Play on Shravani Vatti or Zee** → audio actually plays. (Previously silent.)
- **Bad audio source** → inline error visible for 3 seconds with the rejection name/message.
- **Click Play on currently-playing row** → stops playback (toggle preserved).
- **Row with missing audioClip** → Play is disabled or labeled "(no audio)" rather than silently failing.

## Tasks view

- **Snoozed filter tab** → renders auto-snoozed tasks with reason ("auto-snoozed — no activity for 30+ days") and relative time ("3 days ago").
- **Badge on the Snoozed pill** shows the count when > 0; hidden at 0.
- **`[Bring back]` per row** → task flips to Active, disappears from Snoozed, inline confirmation: *"Brought back — back in your active list."*
- **`[Bring back all]`** → clears the whole Snoozed list, summary flash "Brought back N tasks".
- **First real return after 2+ weeks** should already have stale tasks auto-snoozed from the sweep that ran at app start. Quick validate: find a task in your active list that's 30+ days old with no recent activity; it should now be in Snoozed.

## Welcome-back "ask" branches

Each renders differently. Force each once to exercise the UI:

- **Contradiction branch** → record a meeting where you state something that contradicts a decision from a prior meeting, then reopen after 2+ days. Card: *"One thing worth a look. [summary]. [Review] [Dismiss]"*.
- **OverdueWithSignal branch** → have an overdue task (`dueDate < now`, `status=active`) that was mentioned in a meeting within the last 14 days. Card: *"One task is past due and you've mentioned it recently: {title}. [Snooze to next week] [Mark done] [Keep as-is]"*.
- **LaunchAtStartupOffer branch** → currently `openAtLogin: false`, reopen after a 3+ day gap during which 3+ calendar events happened without recording. Card: *"Want Inwise to start automatically when you log in? You missed a few meetings while it was closed. [Turn on] [Not now]"*.
  - `[Turn on]` → card morphs: *"Done. Inwise will start automatically next time you log in."* `app.getLoginItemSettings().openAtLogin` becomes true. Re-open app → offer no longer appears.
- **No ask qualifies** → empty-state copy (see "On app start" above).

## Silent checks (tail `app.log`)

These are the signals that previously-broken behavior is fixed:

- **Zero** `ERROR calendar-sync | Unknown modifier $setOnInsert` lines. (Previously spammed every 5 min.)
- `staleness-sweep | snoozed=N eligible=E of total active tasks=T` logged on every app start.
- `pipeline:likely-done | flagged=N tasks` after every successful meeting pipeline.
- Per-calendar `calendar-watcher:fetch | calendarId=X label="Y" got=N events` and aggregate `calendar-watcher:poll | Done — total=M unique events across K calendars`.
- `renderer:unhandled-rejection` entries replace silent swallowed failures in the audio stack.
- `login-item | openAtLogin=true|false` when the launch-at-startup offer is acted on.
- `audio-data:received | calendarEventId=...` when a manual Record is linked to a calendar event.

## Recovery checks (when something goes wrong)

- **Auto-snooze was wrong** → Tasks → Snoozed filter → `[Bring back]` on the row. Task is back in Active. No data lost. Test reversibility by bringing back a just-snoozed task.
- **Playback silently fails** → inline error shows in the voiceprint row; `app.log` has a `renderer:unhandled-rejection` line with the reason.
- **Manual Record didn't attach to calendar event** → check `app.log` for `audio-data:received | calendarEventId=undefined`. If undefined despite an active event existing, the issue is in the `calendar:active-event` IPC path.
- **Welcome-back screen didn't appear after a real gap** → check `app.log` for `welcomeBack:compute` call result; if it returned null, the dismiss timestamp may be fresher than `lastOpenedAt` (edge case: app kept running in tray).

---

## Test data reset helpers

If you want to reset state to test from scratch:

- **Force welcome-back to re-appear** → edit `%APPDATA%/inwise-opensource/config.json` and delete `welcomeBackLastSeenAt` (or set to null).
- **Force staleness sweep to re-run** → edit the sweep result cache (in-memory only — just restart the app after artificially aging some `updatedAt` fields in `tasks.db`).
- **Clear missed-meeting detection** → restore `lastOpenedAt` to a recent timestamp.
- **Reset launch-at-startup offer** → `app.setLoginItemSettings({ openAtLogin: false })` manually in devtools or via terminal launching the Electron binary.

## Known deferred items (NOT in this build)

Noted for completeness; expect these in future Ralph rounds:

- Web-app welcome-back (desktop only for now).
- Adaptive snooze thresholds that learn from user "bring back" overrides.
- "Always show full activity on return" settings toggle for power users who want the chore list.
- Parallel recording of simultaneous meetings (conflict modal currently forces the user to pick one).
