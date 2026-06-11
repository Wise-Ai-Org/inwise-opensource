# PRD: Native Zoom Transcript Pull (OSS)

**Status:** Draft — ready for prd.json / Ralph
**Date:** 2026-06-01
**Repo:** inwise-opensource (master)

## Overview

Give the OSS desktop app a way to ingest meeting transcripts **without the local recorder and without a meeting-join bot**, by pulling the transcript Zoom already produced for a cloud-recorded meeting. The fetched transcript is normalized and fed into the existing Jira-mapping / de-dupe / upkeep pipeline.

This is the privacy-clean capture path: no recorder, no bot joining the call, real named-speaker labels, and fully MIT-compatible (HTTP + VTT parse only). Zoom is platform #1; Teams and Meet are deliberately out of scope for this slice.

## Goals

1. A user can connect their own Zoom account (BYO OAuth credentials) and fetch the transcript for a recent cloud-recorded meeting.
2. The fetched transcript is normalized into a shared transcript model with **named speakers** and timestamps.
3. The normalized transcript flows into the existing mapping/upkeep pipeline exactly as recorder output does today.
4. Nothing leaves the machine except the authenticated calls to Zoom's own API. No third-party (Recall) cloud.

## Non-goals (this slice)

- Teams and Google Meet (later platforms).
- Real-time / live transcription. This is post-meeting pull.
- Auto-detection of meeting end / background polling. **Manual trigger only** in v1.
- A published Inwise Zoom Marketplace app. v1 is **BYO-credentials** (user registers their own Zoom OAuth app).
- Acoustic diarization. Speaker names come from Zoom's transcript; we do not infer them.

## Key decisions (locked)

- **Capture = native transcript pull (option C)**, not a bot (B), not Recall (A).
- **Auth = BYO-credentials**: user pastes their own Zoom OAuth app client ID/secret; no secret ships in the repo.
- **Diarization** comes free from Zoom's per-participant VTT — true names, not "Speaker 1."
- Dependency on the **host having cloud recording + audio transcript enabled**; handle the "no transcript" case gracefully rather than failing.

## User stories

- As an OSS user, I connect my own Zoom app once so the desktop app can read my cloud recordings.
- As an OSS user, after a recorded Zoom meeting I click "Fetch from Zoom," pick the meeting, and the transcript is pulled in and run through mapping/upkeep — same as if I'd recorded it locally.
- As a privacy-sensitive user, I can see that my audio never left Zoom's own platform and no recorder ran.

## Build stories

### Story 1 — Transcript-ingestion adapter (the seam)
The pipeline today only accepts the local recorder's output. Introduce a normalized transcript model and an ingestion entry point that any source can feed.
- Define `NormalizedTranscript`: `{ meetingId, title, startedAt, segments: [{ speaker, startMs, endMs, text }] }`.
- Add an ingestion function that accepts a `NormalizedTranscript` and drives the existing mapping → de-dupe → upkeep flow (reuse the recorder's downstream entry; do not duplicate logic).
- **AC:** a hand-built `NormalizedTranscript` fixture, passed to the ingestion function, produces the same mapping/upkeep result path as a recorder transcript.

### Story 2 — Zoom BYO-credentials OAuth connect
Settings UI to register and connect a user-owned Zoom OAuth app.
- Settings fields: Zoom Client ID, Client Secret (stored in local DB, not in repo/config).
- OAuth Authorization-Code flow for a desktop app via loopback redirect (`http://localhost:<port>/callback`) or registered custom scheme; document the exact redirect URI the user must add to their Zoom app.
- Persist + refresh tokens in the local DB; scope: `cloud_recording:read`.
- **AC:** user completes connect, token stored, app can call a Zoom "list recordings" endpoint and get 200.

### Story 3 — List + locate transcript artifact
Call the Zoom API to list the user's recent cloud recordings and find the audio-transcript (VTT) file for a chosen meeting.
- List recent recordings (title, date, meeting id).
- For a selected recording, locate the `TRANSCRIPT` recording file and obtain its download URL (with auth).
- **AC:** given a meeting that has a transcript, the app resolves a downloadable VTT URL; given one without, it returns a clear "no transcript available" state.

### Story 4 — VTT parse → NormalizedTranscript
Download the VTT and parse Zoom's speaker-labeled cues into the Story 1 model.
- Parse cue timestamps and speaker-name prefixes into `segments`.
- Map to `NormalizedTranscript`.
- **AC:** a sample Zoom VTT parses to ordered segments with correct speaker names and ms timestamps (unit-tested against a fixture in `test-transcripts/`).

### Story 5 — Manual "Fetch from Zoom" trigger + states
Wire the UI action that runs the full chain.
- "Fetch from Zoom" → list recent recordings → user picks one → fetch → parse → ingest (Story 1).
- Handle states: not connected, no recordings, no transcript on the meeting, expired/refreshing token, fetch error.
- **AC:** end-to-end — a real cloud-recorded Zoom meeting with transcript enabled is fetched and appears mapped/upkept in the app; each error state shows a clear message rather than a silent failure.

## Technical notes

- Reuse the recorder's existing downstream pipeline entry; Story 1's adapter is the only new seam. ~80% reuse downstream.
- No new copyleft dependencies. VTT parsing is trivial / permissive-licensed only — keep the tree MIT-clean (verified 2026-06-01).
- Store Zoom credentials/tokens in the existing local DB layer, never in committed config.
- Put VTT test fixtures in the existing `test-transcripts/` area.

## Out of scope / follow-ups

- Teams (Graph, admin-consent) and Meet (restricted scopes) as platforms 2 and 3.
- Optional auto-fetch on meeting end.
- Optional published Inwise Zoom app for one-click connect (web/hosted-product concern).
