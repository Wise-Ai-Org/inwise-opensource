# Inwise 1.7.8: Ollie gets ahead of your day, and Jira stays in step

- Ollie shows up at four moments: when your day begins, before each meeting, after a meeting is processed, and at the end of the day. The "processed" notice waits until your meeting is over.
- The live-meeting banner no longer comes back for a meeting you already recorded, and the morning and wrap-up cards count meetings the same way.
- Jira changes from meetings wait for your OK by default. Settings has an option to let Inwise apply changes it is very sure about on its own.
- Recaps suggest Jira updates from what was said: a new ticket, a comment, moving a ticket to In Progress or Done, assigning someone, marking a ticket as blocked by another, or adding it to the current sprint. Nothing is sent twice when a meeting is processed again.
- Prep, morning and wrap-up cards show the Jira tickets that matter: the other person's, yours, and what moved today.
- People who cannot be matched to Jira by email can be linked once with Find in Jira on the People tab.
- Inwise checks Jira at launch and every 30 minutes, only for tickets around you and your default project.
- After updating, reconnect Jira once in Settings. It lets Inwise find people in Jira and run the weekly personal data check-in Atlassian requires.

Validation: all 56 regression test files; live run of a test meeting against a test Jira project (status change, assignment, blocking link, comment, no-sprint case, and a repeat of the same meeting). No real user data was used.

Windows x64 installer. This build is unsigned. No new macOS installer is included.

# Inwise 1.7.7 — Owl branding

- Uses the approved owl artwork with lowercase `inwise` beside it in the desktop title bar, sidebar and onboarding.
- Documents the shared logo treatment for future screens.
- Retains the 1.7.6 recording, recovery and Owl interface functionality.
- Organisation connectivity is not enabled in this release; it will be developed separately with privacy controls.
- Windows x64 installer. This build is unsigned.

# Release Notes

## 1.7.6 — One Owl design across Inwise Desktop

- Applies Inwise Product Design System 3.0 from the approved compact desktop reference: true-white surfaces, Owl colours, the 12/13/15/18 type scale, quiet dividers, branded window controls, and compact lists.
- Meetings, tasks, people, detail pages, settings and integration sections, search, review, capture sheets, onboarding, daily plans, and the floating recorder share the same visual roles.
- Keeps recording controls, the audio-responsive glow, the five-minute silence check with two minutes to respond, saved-audio retry/export, and interrupted-session recovery.
- Makes standalone review tabs keyboard-accessible and fixes garbled punctuation in the people list.
- `inwise-opensource` remains the only maintained desktop app; the retired recording SDK is not included.

Validation: automated navigation and screenshots of app screens/states at compact and wider widths; all existing regression tests and Electron decoder, stereo, save/retry/export, restart-recovery, and simulated-microphone checks. Test data, microphone audio, and provider failures are synthetic; live external integrations and physical devices are not exhaustively tested.

Windows x64 installer, unsigned. Existing recordings and settings are retained. No new macOS binary is included in this release.

## 1.7.5 — Borderless recorder and safer recovery

- A borderless navy-and-teal recorder with an audio-responsive internal glow, a visible timer and Stop & save, device settings, and two-arrow access to the main app.
- After five quiet minutes, an Inwise prompt offers two more minutes to respond before stopping and saving. Keep recording or resumed sound cancels the timeout.
- Original audio is saved before decoding. Empty captures receive a useful message instead of a decoder exception; non-empty audio remains available after processing failures.
- Recording, saving, decoding, transcription, and insights failures identify the failed step and offer appropriate retry/export actions. Saved work can be recovered after an interrupted app session.
- Saved recordings open in Inwise; processing and insight updates appear on the recording. Failed insights no longer report successful completion.

Validation: 43 existing test files plus Electron decoder, stereo, save/retry/export, restart-recovery, desktop-pipeline, and simulated-microphone UI checks pass. Speech/AI failure tests use injected failures; this is not a claim that every physical microphone or provider has been tested.

Windows x64 installer. This release is unsigned. Existing saved recordings, meetings, and settings are retained on update. No new macOS binary is included.


## 1.6.0 — Close the Loop

An action item can now move from meeting evidence to approved AI-assisted execution and
back into Inwise with a durable outcome. Claude, Codex, OpenWorker, or another MCP host
still performs any external work; Inwise supplies the source context, enforces the
approval boundary, and keeps the resulting record attached to the original task.

- Open an action item with its full description, owner, due date, source meeting,
  source-grounded starter recommendation, and execution history.
- Review the exact objective, steps, external tools, recipients or systems, and data to
  be shared before anything can start.
- Record a time-bounded approval with the approving identity, calling client, scope, and
  an idempotency key that makes retries safe.
- Write progress, completion, or failure outcomes back to Inwise, including artifact
  links, provider IDs, and remaining work.
- Move the local task to `inProgress`, `done`, `snoozed`, or back to `todo` with an
  execution-linked reason and optimistic-concurrency protection.
- See the complete execution as a polished card in the Windows and macOS task detail
  view, from review through verified completion.

The local MCP surface now reports thirteen capabilities: the original ten read tools
plus `start_action_execution`, `append_action_outcome`, and `update_action_status`.
Writeback remains off by default and can be enabled separately under
**Settings → Connect to AI**. Inwise never calls Gmail, Docs, Calendar, Jira, or another
external system on the client's behalf.

Setup, approval semantics, screenshots, and the complete test flow are documented in
[`docs/action-execution.md`](./docs/action-execution.md).

## 1.5.0 — Teams and Google Meet transcripts

Completed transcripts from the meeting tools you already use can now join the same
local Inwise history as native recordings.

- Manually import completed Microsoft Teams and Google Meet transcripts with your own
  provider credentials.
- Keep OAuth credentials and imported transcript data on the local machine.
- Prevent duplicate imports and preserve provider/source identity for later review.
- Retain the strengthened Slack ingestion, Zoom handling, and recording-silence checks
  included in this release line.

## 1.4.0 — Local MCP meeting intelligence

Inwise can now serve your meeting history to OpenWorker and other local MCP clients from
**Settings → Connect to AI**. The server listens only on `127.0.0.1` and exposes ten
read-only tools for meetings, action items, people, upcoming calendar events, and meeting
prep.

- Search meeting titles, summaries, and transcript text, then open a meeting for its
  summary, decisions, blockers, commitments, and a short transcript excerpt.
- Fetch full transcripts only through a separate paginated tool, so routine requests do
  not pull a whole conversation into model context.
- Inspect open action items, owners, due dates, and snooze state.
- Review people, relationship history, outstanding work, commitments, and overdue nudges.
- Prepare a source-linked agenda from prior discussions and obligations, or list the next
  day of connected-calendar meetings.
- Check the local connection and Inwise version without exposing meeting data.

OpenWorker setup and privacy details are in [`docs/openworker.md`](./docs/openworker.md).

## 1.3.0 — Task mention deduplication

The same task, said three different ways in three different meetings, used to become
three cards. Now Inwise recognizes it as one.

When a task is extracted from a meeting transcript or a voice note, Inwise compares it
against your open tasks — first by wording, then by asking your configured model whether
it is genuinely the same piece of work. Confident matches merge onto the existing card.
Uncertain ones do not guess: you get a one-tap "Same task / New task" confirm in the same
review pane where extracted tasks already appear. Everything else is created as a new
task, exactly as before. If the model call fails for any reason, task creation still
happens — dedup degrades, it never blocks.

- Repeat mentions merge onto one card instead of piling up duplicates. Tasks from voice
  notes go through the same matching as tasks from meetings; previously they had none at all.
- Every task shows a thread of each time it came up: the source, the date, and the quote.
  Tasks mentioned only once look exactly as they did before — no extra chrome.
- Anything that got merged can be split back out into its own task, and you can merge two
  cards by hand whenever the matcher misses one.
- When a task comes up three times in a week, its card offers to bump the priority. It is
  a tap. Priority never changes on its own, and a task you already finished is never
  silently reopened.
- Matching runs on your own API key through the provider you configured, and the confirm
  card names the model that made the call.
- Every match decision is written to a local `match-decisions.db` so you can see how the
  matcher behaves on your own data. It never leaves your machine.
- Recurring meetings now store their series ID, so occurrences of the same standing
  meeting are recognized as one series instead of unrelated events.
