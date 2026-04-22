# Inwise — Local-First Meeting Intelligence

AI-powered meeting recorder that runs entirely on your machine. Your audio, your transcripts, your action items — none of it leaves your computer except to your Jira or LLM of choice, and only with your key.

- **Local transcription** via [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — no audio ever leaves your device
- **Local speaker voiceprints** via MFCC — identifies who said what, then auto-names it next time
- **Local storage** — NeDB single-file databases, all in your user profile directory
- **Your own LLM key** — Claude (Anthropic) or OpenAI for action-item extraction, transcript summaries, and insights
- **Your own calendars** via ICS feed — Google, Outlook, or any provider that exposes a secret ICS URL
- **Welcome-back screen** — when you return after a gap, the app tells you what it handled for you instead of piling work on you
- **Jira integration** — auto-push action items to stories, optional daily pull

---

## Requirements

- **Windows 10/11** (macOS build in progress — see `build/` config)
- **Node.js 18+** for the build step
- **An Anthropic or OpenAI API key** — you bring your own; nothing routes through Inwise servers
- **Access to a secret ICS URL** from at least one calendar (Google / Outlook / other)

---

## Install

```bash
git clone https://github.com/Wise-Ai-Org/inwise-opensource.git
cd inwise-opensource
npm install
npm run build
npm start
```

The first run downloads whisper.cpp binaries and your selected Whisper model (~150 MB for `base`, ~750 MB for `medium`). This happens once; subsequent launches start instantly.

---

## First-run permissions walkthrough

Inwise needs three OS-level permissions. If any are missing or silently denied, the app will flag it on the Record Meeting pill with an amber dot and a tooltip explaining which one is broken.

### Windows
1. **Microphone** — Windows Settings → Privacy → Microphone → "Let desktop apps access your microphone" → **On**
2. **Screen recording / system audio** — when you hit Record Meeting the first time, Windows may prompt for desktopCapturer permission; allow it. Without this, other participants' voices won't be captured and your transcripts will only contain what your mic picked up
3. **Notifications** — Windows Settings → Notifications → "Inwise" → **On**. Used for "meeting starting" reminders and for alerting you mid-call if audio capture breaks

### macOS (when the Mac build is available)
1. **Microphone** — System Settings → Privacy & Security → Microphone → **Inwise: On**
2. **Screen & System Audio Recording** — System Settings → Privacy & Security → Screen & System Audio Recording → **Inwise: On** (required to capture other meeting participants)
3. **Input Monitoring** — System Settings → Privacy & Security → Input Monitoring → **Inwise: On** (for global hotkeys)

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
- Windows routed output to a Bluetooth headset and desktopCapturer captured the local speakers (which were silent)

Check: before your next call, look at the Record Meeting pill. An amber dot means audio health is degraded — hover for the specific reason. The app will also fire a desktop Notification mid-call if system audio drops.

**Quick fix:** make sure the app you're meeting through is set to output to the same device you've chosen in Windows Sound settings, and that audio starts flowing (someone says "hi") before you hit Record.

### My recording was cut short / died at 2 minutes
Older builds had a hardcoded 2-minute Whisper timeout. If your `dist/` was built before `e1eaad5` (Apr 22, 2026), rebuild with `npm run build`. The new timeout scales with audio length — up to 3.6 hours for very long calls.

### "Processing recording..." has been showing for 10+ minutes
The pipeline died silently. Check `%APPDATA%/inwise-opensource/app.log` for the last `pipeline:start` line and what followed. The WAV file for the recording is preserved at `%APPDATA%/inwise-opensource/recordings/inwise-rec-{timestamp}.wav` — you can re-run transcription manually on it, or delete the stuck meeting entry and try again.

### My calendar isn't syncing
Check `%APPDATA%/inwise-opensource/app.log` for `calendar-watcher:poll` lines. If you see `got=0 events`, the ICS URL is wrong or your calendar has no upcoming items. Google secret ICS URLs can expire if you reset sharing or change your password — re-copy from Calendar settings.

### I came back after a month and my task list is empty
The staleness sweep auto-snoozes tasks that haven't been touched in 30+ days, aren't high-priority, and weren't mentioned in any meeting in the last 14 days. Go to **Tasks → Snoozed filter** and hit `[Bring back]` on anything that's still relevant. Nothing is ever deleted automatically.

### I want to report a bug
1. Open **Settings → Support → Export diagnostic bundle** (when available — see "Roadmap" below) — this zips your `app.log`, recent meeting metadata (redacted), and device info
2. Open an issue at [github.com/Wise-Ai-Org/inwise-opensource/issues](https://github.com/Wise-Ai-Org/inwise-opensource/issues) and attach the bundle

Until the diagnostic bundle ships, please attach:
- `%APPDATA%/inwise-opensource/app.log`
- A description of what you expected vs. what happened
- The timestamp the bug occurred so I can grep logs

---

## Where your data lives

Everything is on your machine. No server round-trips except to your chosen LLM API and optional Jira.

| What | Where |
|---|---|
| Config (API key, calendars, preferences) | `%APPDATA%/inwise-opensource/config.json` |
| Meetings | `%APPDATA%/inwise-opensource/meetings.db` |
| Tasks | `%APPDATA%/inwise-opensource/tasks.db` |
| People + voiceprints | `%APPDATA%/inwise-opensource/people.db`, `voiceprints.db` |
| Raw recordings (stereo WAV) | `%APPDATA%/inwise-opensource/recordings/` |
| Whisper binaries | `%APPDATA%/inwise-opensource/whisper-bin/` |
| Whisper models | `%APPDATA%/inwise-opensource/whisper-models/` |
| Log | `%APPDATA%/inwise-opensource/app.log` |

To reset the app completely: quit Inwise, delete `%APPDATA%/inwise-opensource/`, restart.

---

## Privacy posture

- **Audio** never leaves your machine. whisper.cpp runs as a local subprocess
- **Transcripts** are sent to your LLM of choice (Claude or OpenAI) *only* when you approve insights extraction, and only with your API key
- **Voiceprints** are MFCC vectors (~1 KB per person) stored in your local NeDB; they aren't audio samples and can't be used to reproduce anyone's voice
- **Calendar events** come from ICS URLs you paste; we don't OAuth your Google/Microsoft account
- **Jira** integration uses OAuth stored in your config; tokens never leave your machine except in direct calls to your Jira instance
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
- **Mac build** (`.dmg` with notarization)
- **Auto-updater** (electron-updater against GitHub releases)
- **Error logging + diagnostic bundle export** for bug reports
- **Mobile companion** (view-only, reads from the same local store via sync)
- **Encrypted cloud backup** with user-held keys (opt-in)

---

## Contributing

Small PRs welcome. For bigger changes, please open an issue first so we can align on approach. The codebase uses Electron 31, TypeScript, React 18, Chakra UI, NeDB for storage, and whisper.cpp for transcription. `npm run build` gates on typecheck (both main and renderer). A simple manual test plan lives in [TEST_PLAN.md](./TEST_PLAN.md).

---

## License

MIT © [Inwise.ai](https://inwise.ai)
