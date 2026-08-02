# Set up Teams and Google Meet transcript imports

Inwise can import a transcript that Microsoft Teams or Google Meet already generated after a meeting. This is a manual, post-meeting import: no bot joins the call and Inwise does not record it locally.

You bring your own OAuth app credentials. They and the resulting tokens are stored in Inwise's local `credentials.db` under your OS user profile. They are not sent to an Inwise service.

## Microsoft Teams

### Create the Entra app

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), open **App registrations** and create a registration.
2. Choose the supported account type that matches your organization. A single-tenant app is simplest for one company tenant.
3. Under **Authentication**, add a **Mobile and desktop applications** platform with this custom redirect URI:

   `http://127.0.0.1:17293/callback`

4. Enable public client flows if Entra shows that option. Do not create or paste a client secret; Inwise uses public-client PKCE.
5. Under **API permissions**, add these delegated Microsoft Graph permissions:

   - `User.Read`
   - `Calendars.Read`
   - `OnlineMeetings.Read`
   - `OnlineMeetingTranscript.Read.All`

6. Ask a tenant administrator to grant admin consent. Microsoft marks the delegated transcript permission as admin-consent-required.
7. Copy the **Application (client) ID**. Optionally copy the **Directory (tenant) ID** if you want to lock sign-in to one tenant.

### Connect in Inwise

1. Open **Settings → Microsoft Teams**.
2. Paste the client ID and optional tenant ID, then save.
3. Select **Connect Microsoft Teams** and finish the browser authorization.
4. Return to Settings, select **Refresh meetings**, and import a completed meeting that has a Teams transcript.

Teams keeps access subject to the meeting and tenant's policies. The signed-in user must be allowed to access the transcript. A tenant administrator can also disable Graph transcript access or speaker attribution. If attribution is disabled, Inwise attempts an unattributed text import.

## Google Meet

### Create the Google OAuth client

1. In the [Google Cloud console](https://console.cloud.google.com/), select or create a project.
2. Enable the **Google Meet REST API**.
3. Configure the OAuth consent screen and add this scope:

   `https://www.googleapis.com/auth/meetings.space.readonly`

4. For a Google Workspace organization, use an **Internal** audience when policy permits. If you use an External app in **Testing**, add your account as a test user and expect refresh tokens to expire after roughly seven days.
5. Under **Credentials**, create an **OAuth client ID** with application type **Desktop app**.
6. Copy both the client ID and client secret. Google's installed-app exchange requires the Desktop client secret even though it cannot be treated as a confidential secret.

### Connect in Inwise

1. Open **Settings → Google Meet**.
2. Paste the Desktop client ID and client secret, then save.
3. Select **Connect Google Meet** and finish the browser authorization.
4. Return to Settings, select **Refresh meetings**, and import a completed meeting with a transcript.

Google Meet conference records are available for 30 days after a meeting ends, so older meetings will not appear.

## Troubleshooting

- **Callback port already in use:** close the other process using port `17293` (Teams) or `17294` (Meet), then connect again.
- **Admin approval required:** a Microsoft tenant administrator must grant the requested delegated permissions.
- **Transcript access is disabled:** ask the Microsoft tenant administrator to review Teams transcript/API policy. Inwise cannot bypass it.
- **No transcript found:** confirm transcription was enabled and completed in the provider before refreshing Inwise.
- **Google access denied or API not configured:** verify the Meet REST API, consent-screen audience/test users, and requested scope in the same Cloud project as the OAuth client.
- **Connection expires after a week:** move the Google consent screen to Internal or Production where appropriate, then reconnect.
- **Already imported:** imports are intentionally idempotent. Inwise will not create a duplicate meeting for the same provider transcript ID.

Disconnecting removes the local provider credentials and tokens. It does not delete meetings you already imported.
