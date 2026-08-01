# macOS release guide

Inwise publishes separate signed and notarized artifacts for Apple Silicon (`arm64`) and Intel (`x64`). The GitHub release workflow compiles and checksum-verifies whisper.cpp natively on each architecture, packages it into the app, executes the signed runtime, rejects non-system dynamic-library dependencies, smoke-tests the app, and verifies the app signature, nested Whisper signature, Gatekeeper assessment, and stapled notarization ticket.

## Prerequisites

- Active Apple Developer Program membership
- A `Developer ID Application` certificate exported as a password-protected `.p12`
- An App Store Connect API key with Developer access
- GitHub Actions enabled for the repository

Configure these GitHub Actions secrets:

| Secret | Value |
|---|---|
| `MAC_CSC_LINK` | Base64-encoded Developer ID Application `.p12` |
| `MAC_CSC_KEY_PASSWORD` | Password for the `.p12` |
| `APPLE_API_KEY` | Base64-encoded contents of the App Store Connect `.p8` key |
| `APPLE_API_KEY_ID` | App Store Connect key ID |
| `APPLE_API_ISSUER` | App Store Connect issuer ID |
| `APPLE_TEAM_ID` | Ten-character Apple Developer team ID |

Never commit certificate files, API keys, or passwords.

## Build locally

On the target Mac, with Node.js 22+, Xcode Command Line Tools, and CMake installed:

```shell
npm ci
npm test
npm run dist:mac
```

Unsigned local packaging is useful for development, but public downloads must come from the signed release workflow. Local builds compile a runtime for the current architecture only.

## Publish

1. Update `package.json` to the release version and merge the tested changes to `master`.
2. Push a matching tag such as `v1.5.0`.
3. Wait for both architecture jobs in **Release macOS** to pass.
4. Verify the generated GitHub release contains a `.dmg` and `.zip` for both `arm64` and `x64`.
5. Install each DMG on clean Apple Silicon and Intel Macs and complete the macOS section of `TEST_PLAN.md` before announcing the release.

`workflow_dispatch` runs the same signed build and verification without publishing a GitHub release. It is the preferred release-candidate check.

The separate **CI** workflow also supports `workflow_dispatch` and requires no Apple credentials. Its two Mac jobs compile Whisper natively, transcribe the bundled JFK sample with the tiny English model, create an unsigned architecture-specific app, and smoke-launch the packaged executable. This is useful for branch qualification, but it does not replace the signed release workflow or clean-device Gatekeeper testing.
