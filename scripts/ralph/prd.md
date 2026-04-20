# inwise-opensource — Voice Enrollment & Recording Reliability Fixes

## Context

The `inwise-opensource` Electron app records meetings, transcribes locally via whisper.cpp, and enrolls speaker voiceprints into a local NeDB (`voiceprints.db`). Investigation of a missed enrollment (2026-04-17 "Shravani Vatti + Anu Codaty | Introductions") and a broken playback UI identified five defects — all silent-failure paths with a single unifying theme: the user has no way to tell something went wrong until it's too late.

## Goals

- Recording started during a known calendar meeting should link to that meeting's attendees so `autoEnrollVoices` and speaker-label replacement actually run.
- Audio capture problems (mic denied, system audio unavailable) should be surfaced at the point of action — on the Record Meeting pill and via desktop Notification — not only inside the small floating Badge.
- Voiceprint playback in Settings must either play or show an explicit error.
- Calendar sync must stop spamming errors every 5 minutes.
- No silent-swallow paths in the audio stack.

## Non-goals

- Changing whisper/MFCC logic, models, or database schema.
- Pre-flight mic permission UX redesign.
- Mobile or Mac build (tracked separately as Part 7 roadmap).

---

## User Stories

### US-001 — Fix voiceprint playback in Settings

**As a user**, when I click Play on a voiceprint row in Settings, I want to hear the saved sample, or see why it failed.

**Why broken today:**
`src/renderer/Settings.tsx:625-649` awaits an IPC call, then calls `audio.play()` without a `.catch()`. The `await` between the click and `play()` breaks Chromium's user-gesture continuity in Electron, causing `NotAllowedError` that is silently swallowed. Data on disk is valid — both existing rows (`Shravani Vatti`, `Zee`) contain well-formed 16kHz mono PCM WAV bytes.

**Acceptance criteria:**
- Clicking Play on a voiceprint with a valid `audioClip` produces audible playback.
- If `audio.play()` rejects for any reason, a visible inline error or toast appears with the rejection's `name`/`message`.
- Clicking Play on the currently-playing row stops it (existing toggle behavior preserved).
- If `audioClip` is missing/null on a row, the Play button either is hidden or shows a disabled state with "(no audio)" label.

**Implementation notes:**
- Chain `.catch()` on the `audio.play()` return value. Route the error into `setState` with a short-lived error message that renders in the row.
- Restructure so the `new Audio(url)` and `audio.play()` are invoked without a preceding `await`. One way: fetch the blob synchronously via a cached fetch-ahead on row mount, or kick off the play() and handle the async load via `audio.oncanplay`. Prefer the latter — set `audio.src = url` then `audio.play()` in a single synchronous click handler.
- Do not change the IPC handler (`src/main/main.ts:1033-1051`); it already normalizes the three NeDB audioClip shapes.

**Test:**
- With the two existing voiceprints (`Shravani Vatti`, `Zee`), clicking Play plays the clip.
- With a fabricated voiceprint whose `audioClip` is null, Play does not produce audio and does not throw — UI indicates no audio.
- Simulate an `audio.play()` rejection (e.g. point `audio.src` at a bad URL temporarily) → error surface appears in UI.

---

### US-002 — Link manual Record Meeting clicks to the current calendar event

**As a user**, when I click "Record Meeting" while a scheduled calendar event is currently active, I want the recording to be associated with that event so the right attendees feed into voice enrollment and speaker labeling.

**Why broken today:**
`src/renderer/Sidebar.tsx:228-233` starts recording via the "Record Meeting" button with no `calendarEventId`. Downstream at `src/main/main.ts:1160-1162`, attendees resolve to `[]` when `calendarEventId` is missing. That skips `autoEnrollVoices` (gate at `main.ts:440`) and causes `replaceSpeakerLabels` to leave speaker 1 un-named in the transcript. This is the root cause of the missing Anu voiceprint.

**Acceptance criteria:**
- When the user clicks Record Meeting, the renderer asks the main process for "the currently active calendar event" (an event whose `startTime` is within a window like `[-5min, +endTime]` from now).
- If an active event is found, the `calendarEventId` is passed into `recording:audio-data` alongside buffer/title/stereo so the pipeline resolves attendees correctly.
- If no active event is found, recording proceeds as ad-hoc (current behavior).
- The transcript label replacement covers both speaker 0 and speaker 1 when a 1:1 event is detected.
- `autoEnrollVoices` is invoked and writes a named voiceprint for the other attendee in 1:1 events.

**Implementation notes:**
- Add an IPC method `calendar:active-event` that returns the current in-progress event (or null) from `calendarWatcher.getUpcomingEvents()`, matching on `startTime <= now && (endTime || startTime + 90min) >= now`.
- `Sidebar.tsx` calls this before posting `recording:audio-data` and includes the returned `id` as `calendarEventId` in the IPC payload.
- Default meeting title to the event's title when one is found, unless the user has typed one.

**Test:**
- With a synthetic calendar event currently active (`attendees=[A, B]`, user=A), clicking Record Meeting → stop → logs show `voice-enroll:auto` and `voiceprints.db` gains a row for B.
- With no active calendar event, clicking Record Meeting → stop → logs show `voice-enroll:skip` (no other attendees). No change to existing ad-hoc behavior.
- Transcript has both `Shravani Vatti` and the other attendee's name replacing `SPEAKER_0` / `SPEAKER_1`.

---

### US-003 — Surface audio-capture health on the Record Meeting pill

**As a user**, before and during recording, I want to see at a glance whether my mic and system audio are being captured correctly, without having to look inside the small Badge overlay.

**Why broken today:**
`src/renderer/Badge.tsx:179` shows a `sysAudioWarning` banner inside the Badge only. Mic failure surfaces as `status='error'` inside the Badge only. `src/main/main.ts:1197` uses desktop `Notification` exclusively for calendar reminders, never for audio failures. `src/renderer/Sidebar.tsx:222-234` renders "Record Meeting" / "Stop Recording" with no audio health state.

**Acceptance criteria:**
- The Record Meeting pill shows a small amber indicator when mic is denied or unavailable.
- The Record Meeting pill shows a small amber indicator when system audio failed to acquire (i.e. the recording will be mic-only / mono).
- Hovering the indicator shows a tooltip explaining the issue and the consequence ("Only your voice will be recorded — other participants won't be transcribed").
- When capture-start fails (mic denied mid-session), a desktop `Notification` fires with a short actionable message.
- The Stop Recording pill reflects the same indicator during recording.

**Implementation notes:**
- Add a health state in the renderer (via IPC event `audio:health` from Badge or a shared main-process state) with shape `{ micOk: boolean; systemAudioOk: boolean; message?: string }`.
- `Badge.tsx` emits health updates: on successful/failed `getUserMedia` calls, and on `desktopCapturer` success/failure.
- `Sidebar.tsx` subscribes to this state and renders the indicator.
- On capture-start failure, `main.ts` fires `new Notification({...}).show()` if supported.

**Test:**
- Start the app with mic blocked at OS level → Record Meeting pill shows amber indicator, tooltip says mic denied.
- Start recording with system-audio source acquisition forced to fail (e.g. unplug virtual cable, or mock desktopCapturer throw) → pill shows amber, tooltip says system audio unavailable, desktop Notification fires.
- Both green when both succeed.

---

### US-004 — Fix calendar-sync `$setOnInsert` error spam

**As a user / future dev**, I want the app.log free of repeated `ERROR calendar-sync | Failed to sync calendar events to DB: Unknown modifier $setOnInsert` lines every 5 minutes, and I want calendar events to actually persist to the local DB.

**Why broken today:**
NeDB doesn't support the full MongoDB update-modifier set; `$setOnInsert` throws. The calendar-sync path calls `update({...}, {$set, $setOnInsert}, {upsert:true})` and NeDB rejects the `$setOnInsert` key.

**Acceptance criteria:**
- No `$setOnInsert` error lines appear in `app.log` during normal calendar polling.
- Calendar events from `getUpcomingEvents()` are persisted into the local calendar events collection (they currently aren't, despite the sync attempt).
- Idempotent: repeated syncs don't duplicate events.

**Implementation notes:**
- Replace upsert-with-$setOnInsert with a find-then-insert-or-update: `const existing = await coll.findOneAsync({ id })`; if found, `updateAsync({_id}, {$set: fullDoc})`; if not, `insertAsync(fullDoc)`.
- Alternatively, use NeDB's supported upsert form: `updateAsync({id}, fullDoc, {upsert: true})` — replaces the doc rather than merging, which is acceptable for calendar event snapshots.
- Keep the call at `syncCalendarEventsToDb` in `src/main/database.ts` (or wherever it's defined).

**Test:**
- Start the app, let calendar polling run for 10 minutes, inspect `app.log` — no `$setOnInsert` errors.
- After a poll cycle, the local calendar events collection has the same count (16) as `getUpcomingEvents().length`.
- Run two polls in quick succession → collection count doesn't double.

---

### US-005 — Catch all audio play/decode rejections globally in the renderer

**As a developer**, I want no unhandled promise rejections in the audio path anywhere — so future audio features don't repeat US-001's silent-swallow bug.

**Why broken today:**
Beyond `Settings.tsx:647`, other `new Audio(...).play()` sites may exist (or be added) without `.catch()`. And nothing logs unhandled rejections surfaced in the renderer.

**Acceptance criteria:**
- Add a `window.addEventListener('unhandledrejection', ...)` handler that forwards to the main process via IPC (or writes to `app.log`) with the rejection reason.
- Audit Badge.tsx, Settings.tsx, TranscriptReviewModal.tsx, Onboarding.tsx, and any other `new Audio(` or `audioElement.play()` call site; ensure each play() has a `.catch()`.
- Any uncaught audio failure lands in `app.log` with a meaningful message.

**Implementation notes:**
- Register the unhandled-rejection handler in the app's top-level renderer entry (likely `src/renderer/App.tsx` or wherever the root React component mounts).
- Prefer a thin helper like `playAudio(audio, onError)` rather than raw `.catch` scattered at every call site.

**Test:**
- Temporarily point a play() at an invalid `src` → `app.log` contains a line with the rejection reason.
- `grep -R "\\.play()" src/renderer` → every match is either chained with `.catch()` or inside an `async`/`await` with a surrounding `try/catch`.

---

## Rollout

- One branch per story, or one branch for the whole batch — whichever Ralph prefers.
- All changes are local to `inwise-opensource`. No schema migrations.
- No backwards-incompatible changes to stored `voiceprints.db` rows.

## Success signal

After a new meeting on the calendar is recorded end-to-end:
- `voice-enroll:auto` appears in `app.log`.
- `voiceprints.db` gains a new named row for the other attendee.
- The transcript has both names replacing `SPEAKER_0` / `SPEAKER_1`.
- Clicking Play on any row in Settings produces audio.
- `app.log` has zero `$setOnInsert` lines and zero unhandled rejections.
