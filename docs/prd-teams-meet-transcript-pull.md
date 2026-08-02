# PRD: Teams + Google Meet Native Transcript Pull

**Status:** Implemented — live account validation pending
**Date:** 2026-08-02
**Repo:** inwise-opensource

## Overview

Extend Inwise's post-meeting native transcript import beyond Zoom. Users connect their own Microsoft Entra or Google OAuth desktop app, choose a recent completed meeting, and import the transcript that Teams or Google Meet already produced. The transcript is normalized and sent through the same local ingestion, de-duplication, and upkeep pipeline as Zoom.

No bot joins the meeting, no recorder is required, and no Inwise-hosted OAuth credentials are involved.

## Goals

1. Connect Microsoft Teams through an Entra public-client Authorization Code + PKCE flow.
2. Connect Google Meet through a Google Desktop-client Authorization Code + PKCE flow.
3. List recent completed meetings and manually import an available native transcript.
4. Preserve native speaker names when the provider exposes them and clearly label unattributed transcript text.
5. Reuse the existing normalized transcript ingestion path and make imports idempotent on the provider transcript ID.
6. Keep credentials and tokens in the existing local credential database.

## Non-goals

- Live transcription, meeting bots, or background auto-import.
- Creating or configuring a user's Entra tenant or Google Cloud project for them.
- Bypassing provider policy, tenant settings, admin consent, transcript retention, or meeting permissions.
- Acoustic diarization for provider transcripts that do not expose speaker attribution.

## User flow

### Microsoft Teams

1. The user creates a public-client Entra app and enters its application/client ID plus an optional tenant ID.
2. Inwise opens the Microsoft authorization page and receives the PKCE callback on `http://127.0.0.1:17293/callback`.
3. Inwise reads the user's recent calendar events, retains Teams meetings, and resolves each selected join URL to an online meeting.
4. Inwise selects the newest transcript, downloads it, parses VTT/JSON cues, and imports it.
5. If speaker attribution is disabled by tenant policy, Inwise retries Microsoft's unattributed transcript representation and labels the speaker as `Unknown speaker`.

Delegated scopes: `User.Read`, `Calendars.Read`, `OnlineMeetings.Read`, and `OnlineMeetingTranscript.Read.All`, plus OIDC/offline scopes. `OnlineMeetingTranscript.Read.All` requires tenant admin consent.

### Google Meet

1. The user creates a Google OAuth Desktop client and enters its client ID and secret.
2. Inwise opens Google authorization and receives the PKCE callback on `http://127.0.0.1:17294/callback`.
3. Inwise lists completed conference records from the last 30 days.
4. For the selected record, Inwise loads the newest completed transcript, transcript entries, and participant display names, then imports normalized segments.

Scope: `https://www.googleapis.com/auth/meetings.space.readonly`. The setup guide recommends an Internal consent screen for Workspace organizations; External apps left in Testing normally issue short-lived refresh tokens.

## Shared architecture

- `oauth-loopback.ts`: provider-neutral PKCE generation and loopback callback handling.
- `database.ts`: provider-neutral local OAuth credential/token storage keyed by `teams` or `meet`.
- `teams-oauth.ts` / `meet-oauth.ts`: provider authorization, refresh, connectivity test, and disconnect.
- `teams-api.ts` / `meet-api.ts`: recent-meeting discovery and transcript retrieval.
- `teams-vtt-parser.ts` / `meet-transcripts.ts`: provider payload normalization.
- `zoom-transcript-ingestion.ts`: shared `NormalizedTranscript` ingestion with explicit source (`zoom_transcript`, `teams_transcript`, or `meet_transcript`) and provider transcript ID de-duplication.

All network traffic goes directly from the desktop app to Microsoft or Google. Credentials, refresh tokens, and imported meeting data remain in the local app data directory.

## Error states

The UI must surface actionable messages for:

- missing or invalid OAuth app credentials;
- callback port already in use, state mismatch, denial, or timeout;
- Microsoft admin consent required;
- Microsoft tenant transcript access or speaker attribution disabled;
- the signed-in Microsoft account not allowed to access a transcript;
- Google API disabled, missing scope, or consent policy denial;
- no recent meetings, no completed transcript, or an expired provider record;
- expired/revoked refresh token or provider rate/API failure;
- a transcript previously imported into Inwise.

## Acceptance criteria

- Unit tests cover PKCE/callback parsing, credential persistence, provider config, pagination, Teams transcript fallback, speaker parsing, Meet participant mapping, timestamp normalization, and source-specific idempotency.
- `npm run build` passes for Electron main and renderer bundles.
- Existing automated TypeScript tests remain green.
- Live validation succeeds with one real Teams transcript and one real Google Meet transcript, including reconnect after token refresh.
- No provider client secret or refresh/access token is committed.
- User setup and provider limitations are documented.

## Release checklist

- [ ] Automated tests and production build pass on the release commit.
- [ ] Teams live E2E: connect, list, import, de-duplicate, refresh, disconnect.
- [ ] Meet live E2E: connect, list, import, de-duplicate, refresh, disconnect.
- [ ] Verify Microsoft admin-consent and unavailable-transcript copy with the target tenant.
- [ ] Verify Google consent-screen mode and Meet API access with the target Workspace.
- [ ] Merge only after required CI checks pass.
