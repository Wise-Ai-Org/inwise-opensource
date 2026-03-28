# inWise Recorder — Open Source

AI-powered meeting recorder that runs entirely on your machine. No cloud required.

- **Local transcription** via [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — no audio ever leaves your device
- **Your own API key** — Claude (Anthropic) or OpenAI
- **Local storage** — SQLite, single file on disk
- **Auto-detects meetings** from Google or Microsoft calendar
- **Extracts action items, decisions, blockers** from every meeting

---

## Requirements

- Windows 10/11 (macOS support coming)
- Node.js 18+
- An Anthropic or OpenAI API key
- A Google or Microsoft account (for calendar sync)

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/Wise-Ai-Org/inwise-opensource.git
cd inwise-opensource
npm install
```

### 2. Set up calendar OAuth

You need to register your own OAuth app (free, takes 5 minutes).

#### Google Calendar
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project → **APIs & Services** → **Credentials**
3. Create **OAuth 2.0 Client ID** → Desktop application
4. Add `http://localhost:3579` as an authorised redirect URI
5. Copy the **Client ID** and **Client Secret**

#### Microsoft Calendar
1. Go to [Azure Portal](https://portal.azure.com) → **App registrations**
2. New registration → any name → Accounts in any org + personal
3. Add redirect URI: **Mobile and desktop** → `http://localhost:3579`
4. Copy the **Application (client) ID**

### 3. Build and run

```bash
npm run build
npm start
```

On first launch, enter your API key and calendar credentials in the onboarding screen.

---

## Usage

- The app runs in the **system tray** — look for the inWise icon
- When a calendar meeting with a Zoom/Teams/Meet link starts, recording begins automatically
- Press **Ctrl+Shift+T** to trigger a test recording
- Past meetings, transcripts, and action items appear in the **Communications** tab

---

## Configuration

All config is stored locally at:
- **Windows**: `%APPDATA%\inwise-recorder\config.json`
- **Database**: `%APPDATA%\inwise-recorder\data.db`

---

## Contributing

PRs welcome. Please open an issue first for large changes.

---

## License

MIT © [Inwise.ai](https://inwise.ai)
