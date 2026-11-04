# Set up Teams and Google Meet transcript imports

Inwise can import a transcript that Microsoft Teams or Google Meet already generated after a meeting. Connected accounts are checked every 15 minutes while Inwise is open. You can also use Sync now or select an individual meeting. No bot joins the call and Inwise does not record it locally.

Inwise provides its own desktop OAuth app configuration. Customers connect their account in Settings → Integrations without creating a Cloud project or entering client credentials. Tokens are stored in the local application profile.

## Microsoft Teams

Inwise uses the public Desktop app Inwise Desktop Transcript Pull (74185c77-5b98-4e0d-83ed-c0d0bf739515) with Authorization Code + PKCE and http://localhost:17293/callback. No client secret is used. Customer sign-in uses the organizations authority, requiring the registration to allow multiple Entra ID tenants. Personal Microsoft accounts are unsupported for transcript APIs.

Microsoft Graph delegated permissions are User.Read, Calendars.Read, OnlineMeetings.Read, OnlineMeetingTranscript.Read.All, and OnlineMeetingArtifact.Read.All, plus openid, profile and offline_access. The transcript permission requires customer tenant-admin consent. Ordinary users do not need to register their own app. The account also needs an active cloud Exchange Online mailbox for calendar discovery, a generated retained transcript and access permitted by the meeting's policies.

Existing token grants retain their original client ID and tenant for refresh. Disconnect clears local tokens and leaves imported meetings intact. Customers can revoke consent through Microsoft; a local disconnect does not revoke the organization's consent grant.

## Google Meet

Users turn on Google Meet and authorize their Google account in the system browser. Inwise's Desktop client configuration is bundled in the ignored assets/google-oauth-client.json. Maintainers provision clientId and clientSecret from Inwise's Desktop client before packaging; the release guard rejects missing configuration or user tokens. Never package a service-account key or confidential web-server secret.

Google Cloud confirmed External / In production on November 2, 2026. Verification remains pending, including the sensitive meetings.space.readonly scope. Conference records are retained for 30 days. Discovery lists meetings organized by the connected account; Inwise also retrieves known IDs saved from active calendar calls. An invitation alone cannot reveal an ended call's missing conference ID.

## Troubleshooting

- **Callback port already in use:** close the other process using port `17293` (Teams) or `17294` (Meet), then connect again.
- **Admin approval required:** a Microsoft tenant administrator must grant the requested delegated permissions.
- **Calendar mailbox unavailable:** the Microsoft account needs an active cloud Exchange Online mailbox. Graph cannot discover meetings from an inactive, soft-deleted, or on-premises mailbox in this flow.
- **Transcript access is disabled:** ask the Microsoft tenant administrator to review Teams transcript/API policy. Inwise cannot bypass it.
- **No transcript found:** confirm transcription was enabled and completed in the provider before refreshing Inwise.
- **Google access denied or API not configured:** verify the Meet REST API, consent-screen audience/test users, and requested scope in the same Cloud project as the OAuth client.
- **Connection expires after a week:** move the Google consent screen to Internal or Production where appropriate, then reconnect.
- **Already imported:** imports are intentionally idempotent. Inwise will not create a duplicate meeting for the same provider transcript ID.

Disconnecting Google Meet revokes access and clears its local tokens while retaining the desktop client configuration for reconnecting. Disconnecting Teams clears its local tokens. Imported meetings are preserved.

## Participant and join-session records

Select **Fetch from Teams** or **Fetch from Google Meet**, then **Get attendance** beside the matching call. Attendance can be fetched even when no transcript exists. Imported native meetings also offer **Participants and join sessions → Refresh attendance**.

- Google Meet uses `conferenceRecords/{record}/participants` and each participant's `participantSessions`, with the same read-only Meet scope above. Each rejoin is preserved. Anonymous and phone users may not be identifiable against a calendar invitation.
- Teams uses `attendanceReports` and `attendanceRecords` under the online meeting. The report must overlap the selected calendar occurrence so a recurring call cannot use another day's attendance. The organizer's policy and `OnlineMeetingArtifact.Read.All` permission govern availability. Existing connections must reconnect after this permission is granted.
- Zoom imports cloud transcripts directly and retrieves `/past_meetings/{uuid}/participants` for attendance. The Zoom OAuth app needs `meeting:read:list_past_participants` (or the corresponding account-level scope) and an eligible paid account. The published app's scope configuration must be updated separately if it does not already grant this permission. Transcript import still succeeds when attendance is denied.

These records prove that the service observed a participant connection, including a silent participant. They do not always expose an email or a verified human identity. Inwise keeps invitation addresses separate and does not infer absence from missing or denied reports.

Transcripts must have been enabled in the service during the meeting and must still be retained. Meet transcription is independent of video recording. Neither an invitation nor live captions guarantees that a retrievable transcript exists.

## Live validation still required

Automated tests use representative provider responses. Account sign-in, tenant consent, and a real completed meeting artifact are needed to verify each connection end to end. Build changes alone do not update an already installed Inwise executable.

Live check on November 2, 2026: Google authorization and token storage succeeded in the installed Inwise app. The conference-list API returned HTTP 200 with zero conference records. The calendar identifies sacha@wexare.com as organizer of the weXare daily standup, so that call is outside this account's organizer-only discovery list. No live participant or transcript artifact could be validated from that empty response.

### Calls you attend

Inwise checks active Google Meet links in enabled calendars every 30 seconds while the app is running and connected. It saves the conference record ID and links it to the calendar meeting. After the call ends, Fetch and automatic transcript sync read that known record directly, subject to Google's access permissions. No desktop recording is required. Only transcripts actually generated by Google can be imported.

Settings → Integrations keeps Google Meet inline with its connection toggle and Fetch button. Within Fetch, **Find a shared call** accepts a Google Meet link for an active call or a shared `conferenceRecords/...` reference for an earlier call. An ended meeting link alone cannot recover its historical record ID.

The exact November 2 standup link was tested: the space was accessible, its active conference was empty, and a date-and-link conference search returned no records. No matching artifact was found in the connected Drive. That historical call's attendance and Google transcript remain unverified; the tracker cannot reconstruct an ID that was never saved.
