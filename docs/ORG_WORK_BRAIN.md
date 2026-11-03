# Desktop → Org work brain (development)

This is a new, opt-in connection for inwise-opensource. The retired desktop-recording-sdk is not used or launched.

The footer link sits beside Controls. Connecting opens the web product and requires normal account sign-in, a matching six-character code, and explicit approval. Approving a device never shares a meeting automatically.

A contribution is a deliberately reviewed org-safe title and summary, an observation date, a canonical project ID (or Unassigned), a work type, and related work IDs. The contributor can write a summary manually or request drafts using their configured AI provider. Drafting uses the private local meeting context and org-visible project catalogue, proposes separate contributions with project/work-type suggestions and confidence, and leaves ambiguous projects unassigned. These are suggestions, not guaranteed redaction or classification; every field requires human review. Changes invalidate review; failed submissions can be retried under the same contribution ID.

Dedicated audio, transcript, private-source, attendee and quote fields are rejected by the sharing endpoint. The contributor must still review the semantics of the approved summary text; server field validation is not an automatic sensitive-text detector. The source-meeting reference stays in the desktop's local provenance file. The connection credential is stored with Electron safeStorage and never exposed to the renderer. OS encryption must be available; there is no plaintext fallback.

Only projects explicitly approved for org visibility appear in the desktop catalogue. A project owner or org admin can approve this in the web work-brain page. Unknown and private projects are excluded; org membership alone is insufficient. Reads and uploads derive the org from authenticated account/session records, never from a supplied org ID. Project privacy changes remove associated contributions from the org feed.

Disconnect revokes future device requests. Already approved contributions remain in the organisation. This first version exposes approved contributions in a dedicated org feed; it does not yet add them to existing AI search, dashboard synthesis, or external write automation.

## Development deployment

- Backend: appwise-functions branch dev, function desktop-work-brain.
- Web: wiseai-web branch dev; /desktop/connect handles approval and /org-work-brain shows approved contributions.
- Desktop development environment: INWISE_WORK_BRAIN_API_BASE=https://appwise-dev-final-a0dxcqcad3dyhpaa.westus-01.azurewebsites.net/api and INWISE_WORK_BRAIN_WEB_BASE=https://yellow-river-03906531e.7.azurestaticapps.net.
- Without overrides the desktop targets the normal product host, where this feature must not be claimed live until that backend/web deployment is separately approved and verified.

## Checks

Backend tests cover forbidden fields, review, pairing expiration/one-time consumption, secret hashing, org isolation, project approval/visibility changes, duplicate retries, conflicting retries, token expiry/revocation and strict real-account authentication. Web tests cover sign-in return-path safety, explicit approval, failure states and recipient rendering. Electron UI tests use an isolated synthetic profile and stubbed connection IPC; they check footer placement, pairing, review gating, failure/retry, private-data exclusion and disconnect without external writes.

Real-account approval, provider sign-in configuration and a live desktop-to-dev account session require a human sign-in/approval check. Passing synthetic tests does not certify those steps. Existing cloud meeting/transcript permissions are not changed by this new connection, which stores no raw transcripts in the cloud.
