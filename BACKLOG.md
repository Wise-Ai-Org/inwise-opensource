# inwise-opensource Backlog

## Bugs

- **No voiceprint recorded for Anu Codaty after 2026-04-18 meeting** — speaker was present in the recording but no named `VoicePrint` entry was created. Need to check local NeDB: is her embedding stored as `Unidentified` (Strategy 4 in the enrollment flow), or did enrollment fail earlier (e.g., no per-speaker time ranges from whisper, or single-speaker diarization)? If stored as Unidentified, add a UI path to rename/claim an unidentified voiceprint from the transcript review modal.
  - Investigate: `src/main/mfcc.ts`, `src/main/database.ts` (VoicePrint collection), `src/renderer/views/communications/TranscriptReviewModal.tsx`

- **Only second half of 2026-04-18 Anu meeting was captured** — recording started mid-meeting. Unknown trigger: manual late-start, `desktopCapturer` source acquisition failure followed by retry, MediaRecorder `ondataavailable` delay, or app resumed from sleep partway through. Add log line at every capture-start with timestamp + source IDs so this is diagnosable next time.
  - Investigate: `src/renderer/Badge.tsx` (capture start path), `src/main/main.ts` around `desktopCapturer.getSources`

## Part 7 — OSS desktop roadmap (from 47-step build plan)

- **32. Extract shared logic into `@inwise/core`** — OSS and freemium currently duplicate MFCC, speaker resolution, and transcript shapes. Pull shared code into a package both can depend on.
- **33. Mac build** — Windows NSIS installer exists. No macOS `.dmg`/notarization yet.
- **34. Export to Markdown / Notion / Obsidian** — transcripts + action items exportable to external knowledge tools.
- **35. Mobile companion for OSS** — view/search-only mobile app reading from the same local store (sync protocol TBD).
- **36. Encrypted cloud backup with user-held keys** — opt-in backup of the local NeDB store, client-side encrypted so the cloud never sees plaintext.
