# inwise-opensource — Launch Reliability & Infrastructure

## Context

Three real 2-speaker meetings this week (Anu Apr 17, ASAN Apr 20, David Apr 22) each failed differently and each was diagnosed only in post-mortem. The common thread: **silent failures with no mid-flight signal to the user**. Combined with the fact that alpha users can't currently ship logs, we can't auto-update them, and there's no release workflow, the app isn't launchable.

This PRD bundles the minimum infrastructure to run a private alpha: reliable recording lifecycle, chunk streaming to disk (no more lost recordings on crash), a diagnostic-bundle export so users can report bugs with one click, auto-updates so fixes reach users in hours instead of weeks, and tray polish as the "delight surface" alpha users actually interact with.

## Goals

- **No recording ever gets lost silently.** Either it completes, or the user knows it failed in-progress (not hours later in post-mortem).
- Meetings that run over, meetings that end early, back-to-back meetings, and forgotten-to-stop meetings all resolve cleanly without a modal or a lost recording.
- Alpha users can report a bug in 30 seconds (button → attach zip) and receive fixes without manually re-downloading.
- Shipping a new version = `git tag + push` and users get the update automatically.
- Tray menu does the common actions (start/stop/launch-at-login/focus) so power users aren't forced into the main window for every interaction.

## Non-goals

- Telemetry / auto-upload of logs (everything is opt-in, user-triggered).
- Mobile companion, cloud backup, web-app welcome-back (all roadmap post-launch).
- Perfect speaker attribution in group calls (the stereo-channel approach is best-effort; out of scope here).

---

## User Stories

### US-001 — Reliable recording lifecycle (silence detection + early warnings + safety cap + clean handoff)

**As a user**, when I'm recording a meeting, I want the app to catch audio problems in the first minute (before I waste 40 minutes), auto-stop when the meeting actually ends, cap runaway recordings at 2 hours, and finalize cleanly when I switch meetings — without me having to remember to click Stop.

**Acceptance criteria:**
- New module `src/renderer/audio-monitor.ts` (or inline in Badge.tsx) that samples RMS on both channels every 30 seconds during an active recording and emits an `audio:health-tick` IPC with `{ micRms, sysRms, elapsedSec }`.
- Main process in `src/main/main.ts` aggregates ticks and triggers three behaviors:
  - **First-60s early warning.** On the first tick(s) after start:
    - `micRms < 0.001 for 30s` → fire desktop Notification *"Your mic isn't picking up sound — check you're not muted at the OS level."* with actions `[Stop & fix]` `[Continue]`.
    - `sysRms < 0.001 for 30s` (after the existing 1.5s start probe passed) → *"System audio dropped — other participants won't be captured for the rest of this meeting."* same actions.
    - Both under threshold → *"Neither mic nor system audio is carrying sound."* same actions.
    - `[Stop & fix]` triggers the clean stop path; `[Continue]` suppresses re-warnings of that same kind for the rest of this recording.
  - **Silence-based auto-stop.** After first 90s, if both channels stay under threshold for 2 consecutive minutes AND previously had signal → auto-stop cleanly. Desktop Notification *"Recording for '{title}' saved."*
  - **2-hour hard cap.** At `elapsedSec >= 2*60*60` regardless of signal → auto-stop, Notification *"Reached max recording length. Saved."*
- Single `finalizeRecording()` entry point in main.ts used by: user-click-stop, silence-auto-stop, 2h-cap, conflict-modal "switch to new." Ensures chunks flush, WAV is written, pipeline is queued, overlay closes.
- **Back-to-back chaining:** when silence auto-stops A and a `meeting-starting` event fires within 2 minutes, a single Notification chains: *"Recording for 'A' saved. Now recording 'B'."* No conflict modal, no interruption.
- **Conflict modal "switch" path:** when user picks "switch to B" in the existing conflict modal (US-006 from round 2), the resolver calls `finalizeRecording()` for A, awaits pipeline-queue, then starts B. Log line: `meeting-conflict:switch | finalized="A" started="B"`.
- Typecheck passes.
- Tests pass: unit tests for the monitor's silence-detection state machine (signal-then-silent → stop; silent-from-start → don't trip auto-stop until `hadSignal`), 90s-grace suppression, 2h-cap, early-warning debounce.

---

### US-002 — Stream recording chunks to disk (crash-safe)

**As a user**, if my machine crashes or I force-quit Electron mid-recording, I want whatever was captured up to that moment to survive instead of disappearing.

**Why broken today:**
`Badge.tsx` accumulates `MediaRecorder` chunks into a `Blob[]` array in renderer memory. On `mediaRecorder.stop()`, they're combined into a single blob, converted to WAV, and sent to main via IPC. If the renderer crashes or the app is killed before `stop()`, everything in RAM is lost. For a 45-minute recording this can be 200+ MB of irrecoverable audio.

**Acceptance criteria:**
- On recording start, main.ts opens a write stream to `userData/recordings/inwise-rec-{timestamp}.webm.partial` (or similar).
- Each `MediaRecorder.ondataavailable` chunk in Badge.tsx is immediately IPC-sent to main (`recording:chunk`); main appends to the open file stream.
- On `finalizeRecording()`:
  - Close the stream.
  - Rename `.webm.partial` → `.webm`.
  - Read the full file, convert webm → WAV (existing code path), write WAV, delete the .webm intermediate.
  - Kick off the pipeline with the WAV path as today.
- On app startup, scan `userData/recordings/` for orphan `.webm.partial` files (from a prior crash). For each: close + rename + convert + queue into the pipeline as if it had finalized normally. Log: `recording:recovered | path=X size=Y`.
- Memory usage during a 3-hour recording stays roughly flat (chunks streamed out as they arrive), not linear with duration.
- Typecheck passes.
- Tests pass: simulate a crash by killing the write stream mid-recording, relaunch, verify the partial file is recovered and converted.

---

### US-003 — Launch infrastructure: diagnostic bundle + auto-updater + release workflow

**As an alpha user**, when I hit a bug, I want to send it to Shrav in 30 seconds. **As Shrav**, when I ship a fix, I want users to get it automatically without re-downloading.

**Acceptance criteria:**

**Part A — Diagnostic bundle (Settings → Support):**
- Add a "Support" section in Settings with an `[Export diagnostic bundle]` button.
- Clicking the button invokes a new main-process IPC `support:export-bundle` that:
  - Tails the last 5,000 lines of `userData/app.log`.
  - Reads `userData/config.json`, redacts `apiKey` and any `jiraTokens.*`, includes everything else.
  - Collects recent crash stack traces (if an error log file exists).
  - Collects the list of most recent 20 entries from `meetings.db` with titles + statuses only (no transcripts).
  - Collects app version, OS, Electron version, Node version.
  - Writes all to a zip at `userData/inwise-diagnostic-{timestamp}.zip`.
  - Opens a file-save dialog pre-populated with that zip; user saves wherever they want.
- Under the button: a one-line helper text *"Attach this to your GitHub issue or email it to support@inwise.ai. No transcripts or audio are included."*

**Part B — Auto-updater (electron-updater):**
- Add `electron-updater` dependency.
- Configure in `src/main/main.ts`:
  - `autoUpdater.setFeedURL({ provider: 'github', owner: 'Wise-Ai-Org', repo: 'inwise-opensource' })` on app start.
  - Poll every 6 hours after launch: `autoUpdater.checkForUpdatesAndNotify()`.
  - On `update-available` event: silent download in background.
  - On `update-downloaded`: show a desktop Notification *"Inwise v{version} is ready. Restart to install."* with actions `[Restart now]` `[Later]`. `[Restart now]` calls `autoUpdater.quitAndInstall()`.
- In Settings, add a "Check for updates now" button (invokes `autoUpdater.checkForUpdates()`).
- Configure `package.json` `build.publish` to point at the GitHub repo.

**Part C — GitHub Actions release workflow:**
- New file `.github/workflows/release.yml`:
  - Triggered on tag push matching `v*`.
  - Runs on `windows-latest` (builds .exe + .blockmap) and `macos-latest` (builds .dmg + .zip, when applicable — currently skip mac builds gracefully if no cert).
  - Uses `npm ci`, `npm run build`, `npm run dist:win` / `dist:mac`.
  - Uses `softprops/action-gh-release@v1` to publish artifacts to the GitHub release page.
- Update `package.json` `build.publish` to `{"provider": "github", "owner": "Wise-Ai-Org", "repo": "inwise-opensource"}`.
- Document the release process in a new `docs/releasing.md`: `git tag v0.2.0 && git push --tags`, then wait ~10 min for the workflow; auto-updater picks it up from users' machines.
- Typecheck passes.
- Verify manually (one-time): push a test tag `v0.0.0-test`, confirm GitHub Actions runs to completion, artifacts appear on releases page. Delete the test release after.

---

### US-004 — Tray menu polish (customer delight)

**As a user**, I want to do the common recording actions from the tray without having to open the main window. **As a power user**, I want the tray to be more than "Open / Quit."

**Acceptance criteria:**
Extend `src/main/tray.ts` `updateTrayMenu()`:
- **"Start recording now"** (enabled only when NOT recording) — opens the overlay for an ad-hoc recording with an auto-generated title ("Recording {datetime}") and no calendarEventId.
- **"Stop recording"** (enabled only when recording) — triggers the same finalize path as clicking stop in the Badge.
- **"Launch at login"** (checkbox) — reflects current `app.getLoginItemSettings().openAtLogin` state; clicking toggles it via the existing `app:setLoginItemOpenAtLogin` IPC.
- **"Focus mode: suppress meeting reminders for..."** (submenu) → `15 minutes`, `30 minutes`, `1 hour`, `until tomorrow`. When active, the calendar-watcher's `meeting-reminder` events are suppressed. The tray menu shows the remaining time in the status label when active.
- **Status label** stays at the top:
  - Idle: "Inwise"
  - Recording: "● Recording — {elapsed}" (updates every 30s)
  - Focus mode: "🌙 Focus until {time}" (append to base label)
- `updateTrayMenu` is called on recording start/stop, login-item toggle, focus mode change.
- Typecheck passes.
- Verify in browser using dev-browser skill: right-click tray icon → see new items; click Start recording → overlay appears; click Stop → overlay closes + pipeline runs; toggle Launch at login → confirm via `app.getLoginItemSettings()` reflects the change; activate focus mode → suppressing a simulated meeting-reminder.

---

## Rollout

- One branch: `ralph/launch-reliability`.
- No schema changes.
- Additive IPCs only. Existing behaviors unchanged unless explicitly replaced (the stream-to-disk in US-002 replaces the accumulate-in-memory path, but falls back to the old path on any failure).

## Success signal

- **5 consecutive recorded meetings** complete end-to-end: stop cleanly (user-triggered or silence), transcript produced, action items extracted, no data loss.
- **Zero recordings lost** to force-quit or crash in 2 weeks of dogfood.
- **First alpha user bug report** arrives with a diagnostic bundle attached, no back-and-forth needed to collect logs.
- **Auto-update flow** tested: push a v0.0.1 → v0.0.2 on a test install, see the update Notification arrive within 6 hours, `[Restart now]` installs the new version, `app.getVersion()` reflects the new version.
- **Tray menu delights**: Start / Stop from tray works without opening main window; focus mode genuinely suppresses reminders.

## Open design questions (out-of-scope)

- Should the diagnostic bundle auto-upload to a hosted endpoint (Sentry-style) or stay user-triggered? Staying user-triggered for v1.
- Should auto-updater be opt-out per user? Probably yes eventually; for alpha, on-by-default is fine since everyone opted in to being alpha.
- Should focus mode also suppress ALL desktop notifications from Inwise, not just meeting-reminders? Open — currently only meeting-reminders.
