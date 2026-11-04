# Google production authorization

Prepared November 2, 2026. Project: inwise-meet-desktop. Desktop OAuth client: Inwise Desktop Meet. App branding: Inwise Meet Desktop. Support/developer contact: shravani@inwise.ai.

## Completed

- Native installed-app browser OAuth with PKCE and loopback callback.
- Inwise client configuration bundled for customers, without credential-entry fields.
- Release packaging guard excludes user-token configuration.
- Existing grant client identity retained for token refresh.
- Consent homepage https://inwise.ai, privacy https://inwise.ai/privacy-policy, terms https://inwise.ai/terms-of-use and authorized domain inwise.ai saved in Google Cloud.
- Desktop build and 50 main test files plus recording and renderer checks pass.

## Publication and verification

On November 2, 2026, the user approved Publish app and Google Cloud confirmed External / In production. The console still requires verification and shows 2 users / 100 user cap. Production publishing does not itself verify the app. Google review is required for meetings.space.readonly, a sensitive scope. Do not claim public rollout or verified status before the console confirms it.

Privacy addendum prepared in C:/Users/Shrav/inwise-website-release/src/content/legal.ts. It must be published and reviewed as a working public page before verification submission. Confirm Search Console ownership of inwise.ai in the project owner's account if Google requires it. Prepare a demonstration video showing the app, browser consent and read-only attendance/transcript import with an accessible real meeting. Do not include user tokens, private calendar URLs or unnecessary meeting content in the video.

Scope justification: Inwise uses meetings.space.readonly to read conference metadata and transcript entries, list actual participants and their join/leave sessions, and resolve an active conference reference from a calendar Meet link so authorized records can be retrieved after the call ends. The app does not create or change meeting spaces and does not request Gmail or broad Drive access.

An invitation is not attendance proof. Authorization does not override Google's meeting-level permissions. No completed live artifact has yet been validated for the current non-organizer account.
