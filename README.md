# Inwise — Local-First Meeting Intelligence

AI-powered meeting recorder that runs entirely on your machine. Your audio, your transcripts, your action items — none of it leaves your computer except to your Jira or LLM of choice, and only with your key.

- **Local transcription** via [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — no audio ever leaves your device
- **Local speaker voiceprints** via MFCC — identifies who said what, then auto-names it next time
- **Local storage** — NeDB single-file databases, all in your user profile directory
- **Your own LLM key** — Claude (Anthropic) or OpenAI for action-item extraction, transcript summaries, and insights
- **Your own calendars** via ICS feed — Google, Outlook, or any provider that exposes a secret ICS URL
- **Welcome-back screen** — when you return after a gap, the app tells you what it handled for you instead of piling work on you
- **Jira integration** — auto-push action items to stories, optional daily pull
- **Local AI access** — connect OpenWorker or another MCP client to search meetings, prepare agendas, and follow up on action items without uploading an Inwise database

---

## Requirements

- **Windows 10/11** or **macOS 13 Ventura or later** (Apple Silicon and Intel)
- **Node.js 22+** for source builds (CI uses Node.js 24)
- **macOS source builds only:** Xcode Command Line Tools and CMake, used to compile the bundled whisper.cpp runtime
- **An Anthropic or OpenAI API key** — you bring your own; nothing routes through Inwise servers
- **Access to a secret ICS URL** from at least one calendar (Google / Outlook / other)

---

## Install

```shell
git clone --recurse-submodules https://github.com/Wise-Ai-Org/inwise-opensource.git
cd inwise-opensource
npm ci
```

On Windows:

```shell
npm run build
npm start
```

On macOS:

```shell
npm run build:whisper:mac
npm run verify:whisper:mac
npm run build
npm start
```

The Windows app downloads its whisper.cpp runtime on first use. The macOS runtime is compiled for the current Mac by `build:whisper:mac`, checksum-verified by `verify:whisper:mac`, and included in release builds. Both platforms download your selected Whisper model on first use (~150 MB for `base`, ~750 MB for `medium`).

If you already cloned the repository, run `git submodule update --init --recursive` once before building.

To use Inwise from OpenWorker, follow the [OpenWorker setup guide](./docs/openworker.md). The connection stays on this computer and exposes a pinned, read-only MCP tool set.

---

## First-run permissions walkthrough

Inwise needs three OS-level permissions. If any are missing or silently denied, the app will flag it on the Record Meeting pill with an amber dot and a tooltip explaining which one is broken.

### Windows
1. **Microphone** — Windows Settings → Privacy → Microphone → "Let desktop apps access your microphone" → **On**
2. **Screen recording / system audio** — when you hit Record Meeting the first time, Windows may prompt for desktopCapturer permission; allow it. Without this, other participants' voices won't be captured and your transcripts will only contain what your mic picked up
3. **Notifications** — Windows Settings → Notifications → "Inwise" → **On**. Used for "meeting starting" reminders and for alerting you mid-call if audio capture breaks

### macOS
1. **Microphone** — System Settings → Privacy & Security → Microphone → **Inwise: On**
2. **Screen & System Audio Recording** — System Settings → Privacy & Security → Screen & System Audio Recording → **Inwise: On** (called **Screen Recording** on macOS 13; required to capture other meeting participants)
3. **Notifications** — System Settings → Notifications → **Inwise: On** for meeting reminders and recording-health alerts

If you don't see Inwise listed, launch the app once, trigger the feature that needs the permission, and macOS will prompt you.

---

## Getting started

On first launch, you'll walk through:

1. **Set your display name** — used as "Speaker 0" on your own recordings
2. **Add your email aliases** — all addresses that identify "you" across calendars (work + personal). Used to filter you out of attendee lists so you don't show up as someone you're meeting with
3. **Paste an LLM API key** — Claude (`sk-ant-...`) or OpenAI (`sk-...`). Stored locally; never uploaded
4. **Add at least one calendar** — Settings → Calendars → Add calendar. Paste your secret ICS URL:
   - **Google**: Calendar settings → [calendar name] → "Secret address in iCal format"
   - **Outlook**: Settings → View all Outlook settings → Calendar → Shared calendars → Publish a calendar → ICS
5. **Enroll your voice** (optional but recommended for 1:1s) — record a 10-second clip in Settings → Voiceprints
6. **Record your first meeting** — join a Zoom/Teams/Meet call, click Record Meeting in the sidebar (or let the calendar-watcher auto-prompt you when the event starts)

---

## Troubleshooting

### My transcript has everything attributed to me (the other person's voice is missing)
Your system-audio capture is silent. Either:
- The app being captured (Zoom/Teams/Meet) wasn't actively playing audio through your speakers at recording start, or
- The OS routed output to a different device than the active meeting output, or
- On macOS, Screen & System Audio Recording permission is disabled

Check: before your next call, look at the Record Meeting pill. An amber dot means audio health is degraded — hover for the specific reason. The app will also fire a desktop Notification mid-call if system audio drops.

**Quick fix:** make sure your meeting app uses the active system output, ensure someone is speaking, and use **Settings → Test System Audio**. On macOS, the test links directly to System Settings when permission was denied.

### My recording was cut short / died at 2 minutes
Older builds had a hardcoded 2-minute Whisper timeout. If your `dist/` was built before `e1eaad5` (Apr 22, 2026), rebuild with `npm run build`. The new timeout scales with audio length — up to 3.6 hours for very long calls.

### "Processing recording..." has been showing for 10+ minutes
The pipeline died silently. Check `app.log` in the platform data directory for the last `pipeline:start` line and what followed. The WAV file is preserved in its `recordings/` directory, so you can recover or transcribe it again.

### My calendar isn't syncing
Check `app.log` in the platform data directory for `calendar-watcher:poll` lines. If you see `got=0 events`, the ICS URL is wrong or your calendar has no upcoming items. Google secret ICS URLs can expire if you reset sharing or change your password — re-copy from Calendar settings.

### I came back after a month and my task list is empty
The staleness sweep auto-snoozes tasks that haven't been touched in 30+ days, aren't high-priority, and weren't mentioned in any meeting in the last 14 days. Go to **Tasks → Snoozed filter** and hit `[Bring back]` on anything that's still relevant. Nothing is ever deleted automatically.

### I want to report a bug
1. Open **Settings → Support → Export diagnostic bundle** (when available — see "Roadmap" below) — this zips your `app.log`, recent meeting metadata (redacted), and device info
2. Open an issue at [github.com/Wise-Ai-Org/inwise-opensource/issues](https://github.com/Wise-Ai-Org/inwise-opensource/issues) and attach the bundle

Until the diagnostic bundle ships, please attach:
- `app.log` from the platform data directory
- A description of what you expected vs. what happened
- The timestamp the bug occurred so I can grep logs

---

## Where your data lives

Everything is on your machine. No server round-trips except to your chosen LLM API and optional Jira.

The data directory is `%APPDATA%/inwise-opensource/` on Windows and `~/Library/Application Support/inwise-opensource/` on macOS.

| What | Path inside the data directory |
|---|---|
| Config (API key, calendars, preferences) | `config.json` |
| Meetings | `meetings.db` |
| Tasks | `tasks.db` |
| People + voiceprints | `people.db`, `voiceprints.db` |
| Raw recordings (stereo WAV) | `recordings/` |
| Whisper models | `whisper-models/` |
| Windows Whisper runtime | `whisper-bin/` |
| Log | `app.log` |

The packaged macOS Whisper runtime lives inside `Inwise.app/Contents/Resources/whisper/`. To reset the app completely, quit Inwise, delete the platform data directory above, and restart.

---

## AI Models & Licenses

The app ships with no pre-bundled AI models. On first use, Whisper model binaries are downloaded to the platform data directory's `whisper-models/` folder:

- **Whisper (OpenAI)** — MIT license. Runtime-downloaded; select `base` (~150 MB) or `medium` (~750 MB) on first launch. Runs entirely on your machine via [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
- **LLM API keys** — bring your own Claude (Anthropic) or OpenAI key. These services' terms apply to API usage; your audio is never sent to Anthropic/OpenAI unless you explicitly ask for insights extraction

---

## Privacy posture

- **Audio** never leaves your machine. whisper.cpp runs as a local subprocess
- **Transcripts** are sent to your LLM of choice (Claude or OpenAI) *only* when you approve insights extraction, and only with your API key
- **Voiceprints** are MFCC vectors (~1 KB per person) stored in your local NeDB; they aren't audio samples and can't be used to reproduce anyone's voice
- **Calendar events** come from ICS URLs you paste; we don't OAuth your Google/Microsoft account
- **Jira** integration uses OAuth stored in your config; tokens never leave your machine except in direct calls to your Jira instance
- **Keys and tokens at rest**: API keys and integration tokens are stored unencrypted in your user profile (`config.json` / `credentials.db`), protected by your OS user account's file permissions — the standard local-first tradeoff. Treat the app's data directory like you'd treat `~/.ssh`
- **Local MCP server** (Settings → Connect to AI): serves meetings, action items, people, and meeting-prep context read-only to AI clients on this machine at `127.0.0.1:43117`. Meeting details return only a short transcript excerpt; full transcripts require a separate paginated tool call. Loopback-only with DNS-rebinding guards, but on a shared multi-user machine other OS accounts can reach loopback ports — turn it off in Settings there. See the [OpenWorker setup and data-boundary notes](./docs/openworker.md#understand-the-data-boundary)
- **Telemetry**: none yet. When it's added (see Roadmap) it'll be opt-in and diagnostic-only

---

## Roadmap

What's shipped:
- Local recording + stereo diarization
- Voice enrollment (MFCC) with auto-identification on repeated speakers
- Multi-calendar subscription (N ICS URLs, any provider)
- Task lifecycle: todo / inProgress / done / snoozed / bring-back
- Welcome-back screen after long gaps (helper-voice, one ask max)
- Simultaneous-meeting conflict modal
- Jira auto-push and daily pull
- Action-item completion inference from transcripts (soft flag, never auto-closes)

What's next:
- **Auto-updater** (electron-updater against GitHub releases)
- **Error logging + diagnostic bundle export** for bug reports
- **Mobile companion** (view-only, reads from the same local store via sync)
- **Encrypted cloud backup** with user-held keys (opt-in)

---

## Contributing

Small PRs welcome. For bigger changes, please open an issue first so we can align on approach. The codebase uses Electron 43, TypeScript, React 18, Chakra UI, NeDB for storage, and whisper.cpp for transcription. `npm test` runs the main-process suite; `npm run build` typechecks and bundles the full application. A manual test plan lives in [TEST_PLAN.md](./TEST_PLAN.md). macOS signing and release setup is documented in [docs/macos-release.md](./docs/macos-release.md).

---

## License

MIT © [Inwise.ai](https://inwise.ai)
