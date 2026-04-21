# inwise-opensource Backlog

## Bugs

- **No voiceprint recorded for Anu Codaty after 2026-04-18 meeting** — speaker was present in the recording but no named `VoicePrint` entry was created. Need to check local NeDB: is her embedding stored as `Unidentified` (Strategy 4 in the enrollment flow), or did enrollment fail earlier (e.g., no per-speaker time ranges from whisper, or single-speaker diarization)? If stored as Unidentified, add a UI path to rename/claim an unidentified voiceprint from the transcript review modal.
  - Investigate: `src/main/mfcc.ts`, `src/main/database.ts` (VoicePrint collection), `src/renderer/views/communications/TranscriptReviewModal.tsx`

- **Only second half of 2026-04-18 Anu meeting was captured** — recording started mid-meeting. Unknown trigger: manual late-start, `desktopCapturer` source acquisition failure followed by retry, MediaRecorder `ondataavailable` delay, or app resumed from sleep partway through. Add log line at every capture-start with timestamp + source IDs so this is diagnosable next time.
  - Investigate: `src/renderer/Badge.tsx` (capture start path), `src/main/main.ts` around `desktopCapturer.getSources`

## Product: Returning-user experience & task lifecycle

- **"Welcome back" screen — helper-voice, not chore-list** — on re-open after N+ days, show a short report of **what the app handled automatically** while the user was out, followed by **at most one** item that genuinely needs their input. Emotional goal: returning user feels helped, not nagged — a user on the edge of churning does not need more homework.
  - **Lead with wins** (app's voice, not user's inbox): "Cleared 12 stale tasks", "3 of your Jira stories progressed", "Matched 5 meetings to Jira issues", "Calendar stayed in sync — 17 upcoming this week".
  - **One ask max**, surfaced as the single most time-critical item (e.g., a flagged contradiction, a blocking overdue task). Everything else stays in its normal view with its normal badge.
  - **Cut from the welcome screen entirely**: "N meetings weren't recorded" (guilt-inducing and un-actionable — they literally couldn't help it), "N recordings need review" (passive inbox, belongs in Communications), granular overdue-task list (Tasks view's badge already handles this).
  - **"Nothing urgent — you're good to go"** is a valid, trust-building outcome; don't invent filler to populate the screen.
  - **State counts, not lists.** "12 tasks cleared" beats scrolling 12 titles. Detail is on-demand via a quiet "review" affordance.
  - **Escape hatches, not forced paths.** Chips at the bottom (Tasks / Meetings / Jira / Calendar) let the curious self-serve without being shoved into anything.
  - **Power-user opt-in**: Settings toggle "Always show full activity on return" for users who actually want the chore list. Default is delight-first.
  - Requires a persisted `lastOpenedAt` timestamp and a `welcomeBackLastSeenAt` to avoid re-showing on rapid re-opens.

- **Task lifecycle: snooze-by-default staleness handling** — tasks with no mentions in subsequent meetings, no Jira activity, and no status change in 30+ days auto-move to a Snoozed state. The user can "bring back" a snoozed task to Active whenever they need. No destructive auto-action — snoozed ≠ archived ≠ deleted; all data preserved. Snoozed tasks surface on the "while you were away" screen for batch review after long absences.
  - Rationale: zero-friction cooldown layer. Active list stays useful; nothing is lost. User retains control via explicit "bring back" action.

- **Task completion inference from transcripts** — when a later meeting transcript contains phrases indicating a task was done ("I finished X", "we already shipped Y"), flag the matching task as *likely-done* and surface a confirmation prompt. Never auto-complete without user confirm. Uses the existing LLM extraction pass; compares against open tasks for the same people/topics.

## Part 7 — OSS desktop roadmap (from 47-step build plan)

- **32. Extract shared logic into `@inwise/core`** — OSS and freemium currently duplicate MFCC, speaker resolution, and transcript shapes. Pull shared code into a package both can depend on.
- **33. Mac build** — Windows NSIS installer exists. No macOS `.dmg`/notarization yet.
- **34. Export to Markdown / Notion / Obsidian** — transcripts + action items exportable to external knowledge tools.
- **35. Mobile companion for OSS** — view/search-only mobile app reading from the same local store (sync protocol TBD).
- **36. Encrypted cloud backup with user-held keys** — opt-in backup of the local NeDB store, client-side encrypted so the cloud never sees plaintext.
