# Alpha-invite templates

Two pieces: a short outreach message you send to the 3-5 people you have in mind, and a longer "what to expect" doc you share with anyone who says yes.

---

## Short outreach message

Subject: *Want to try a private alpha of something I've been building?*

Hey {name},

I've been building a meeting intelligence tool called Inwise — it records your calls, transcribes them locally (no cloud), extracts action items, and tracks voice signatures so repeat attendees get auto-named. All of it runs on your machine with your own LLM key. I'm about to open it up to 3-5 people for a private alpha and you came to mind because {specific reason — they're in a role that'd actually use this / they've been vocal about similar problems / they'll tell me plainly what sucks}.

A few things to know before you say yes:

- It's Windows-only right now; Mac build is in progress
- First-run setup takes ~10 minutes (paste an API key, add a calendar ICS URL, maybe enroll your voice)
- It will have bugs. That's why I'm asking you specifically — I want someone who'll tell me when things break rather than quietly walk away
- Your data stays on your machine. No telemetry, no cloud sync. I won't see your recordings unless you send me a log file

If you're in, I'll send you install instructions and a short "what to expect" doc. Takes an hour or two of your time over the next two weeks, broken up across whatever meetings you'd naturally record.

No pressure — happy to answer questions or reschedule if now's not the right moment.

— Shrav

---

## What to expect (share this after they say yes)

Inwise is early. Here's what I need from you and what I promise in return.

### What I'm asking from you

1. **Install it and complete first-run setup** (~10 minutes)
2. **Record ~5 real meetings over the next two weeks** — not test recordings, real ones. 1:1s are most useful; group calls are a bonus
3. **Tell me when something breaks**, even if you can't articulate why. "It felt weird here" is valuable
4. **Send me your `app.log` when I ask for it** — it's at `%APPDATA%/inwise-opensource/app.log` on Windows. You can always read it first and redact anything sensitive; it's plain text. Don't worry, transcripts aren't in it

### What I'm promising you

1. **Nothing leaves your machine without your explicit action.** Recordings, transcripts, voiceprints — all local. If we add telemetry it'll be opt-in only
2. **I'll respond to any bug report within 24 hours**, and ship a fix within a week for anything that breaks your workflow
3. **You get a permanent free license** when we eventually have licenses (no commitment implied — you can stop anytime)
4. **I will listen more than I defend.** If something feels bad, your read is probably right. I won't argue you out of your first impression

### Known rough edges (so you don't waste time reporting them)

- Mac isn't supported yet — Windows 10/11 only
- The first recording can take 30-60 seconds to download Whisper binaries — this is a one-time cost
- The "While you were away" screen is new. If it shows anything wrong, screenshot and send
- Voiceprint enrollment for group calls is still rough — it works reliably for 1:1 meetings but group diarization is best-effort
- There's no auto-updater yet. When I ship fixes I'll message you and you'll have to re-download the installer manually. I'm adding the auto-updater next

### How to report something

Most reliable path: open an issue at `github.com/Wise-Ai-Org/inwise-opensource/issues` and attach your `app.log` (or email it to me directly if you'd rather). Include:
- Roughly when it happened (date + time)
- What you expected vs. what you saw
- A screenshot if it's UI-related

For anything urgent that blocks your meeting — text me. I'll help in real-time if I'm around.

### When you're done or want out

Just tell me. No wind-down, no exit survey. You can delete `%APPDATA%/inwise-opensource/` and the app from your machine and it's like it was never there.

---

## Follow-up cadence

Not in the template, but for reference:

- **Day 1 after they install**: short check-in. "Did setup work? Anything confusing?"
- **Day 3-4**: "Recorded anything yet? Any surprises?"
- **End of week 1**: ask for `app.log`, diff against what you expect to see, identify any silent-failure patterns
- **End of week 2**: structured feedback — what was useful, what was friction, what was missing, would they pay for this and at what price
