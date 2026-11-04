# Teams production authorization

Application: Inwise Desktop Transcript Pull. Client ID: 74185c77-5b98-4e0d-83ed-c0d0bf739515. Home tenant: 85155a36-f5b6-437b-b486-978f2d731263 (Wise.ai).

The desktop app bundles this public native-client ID, uses the organizations authority, PKCE and http://localhost:17293/callback, and requires no customer client credentials. Existing grants retain their client and tenant for refresh. Disconnect clears local tokens, not customer organization consent or imported meetings.

On November 2, 2026, Entra showed single-tenant access and an existing desktop callback. Calendars.Read, offline_access, OnlineMeetings.Read, OnlineMeetingTranscript.Read.All and User.Read were delegated and Granted for Wise.ai. OnlineMeetingArtifact.Read.All was absent. Following explicit user approval, Multiple Entra ID tenants / Allow all tenants was saved and Microsoft confirmed successful admin consent, including OnlineMeetingArtifact.Read.All Granted for Wise.ai.

Customer administrators must consent to OnlineMeetingTranscript.Read.All. No app-only tenant-wide meeting access is requested. Publisher verification, public privacy/terms links and real completed Teams artifact validation must be checked before claiming production readiness. The current account previously had an unavailable Exchange Online mailbox, so identity sign-in success alone is insufficient.

Build and automated checks passed. The source includes a compact Teams connection toggle and Fetch button in Integrations with no credential-entry flow. Deployment and cloud authorization status must be recorded separately.

Homepage, privacy and terms links were saved. Publisher domain is inwise.ai; verified MPN ID is absent and publisher verification remains incomplete. Tested compiled files were installed with a recoverable dist backup at artifacts/installed-dist-before-teams-production-20261102. Installed Inwise processes restarted, but the desktop-control launcher did not expose a window for visual confirmation. No live Teams sign-in, transcript or attendance artifact was validated in this session.

Publisher verification completed following explicit user acceptance of Microsoft Platform Policies. Partner Center confirmed Inwise AI PartnerGlobal ID 6872219 (PartnerLocation 6872220 is not used). Entra saved 6872219, and Check for updates → Verify and save populated publisher display name Inwise AI and removed the unverified-publisher warning. Evidence: artifacts/microsoft-publisher-verified.jpg. This does not replace customer tenant consent or prove live transcript/attendance import.
