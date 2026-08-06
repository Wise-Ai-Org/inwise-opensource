# Windows release guide

Inwise publishes an Authenticode-signed x64 NSIS installer. The release workflow
signs the packaged app and installer, creates the stable
`Inwise-Setup-Windows.exe` download, and rejects the release if any signature is
missing or invalid.

## Prerequisites

- A Windows Authenticode code-signing certificate exported as a
  password-protected `.pfx`
- GitHub Actions enabled for the repository

Configure these GitHub Actions secrets:

| Secret | Value |
|---|---|
| `WIN_CSC_LINK` | Base64-encoded Authenticode `.pfx` |
| `WIN_CSC_KEY_PASSWORD` | Password for the `.pfx` |

Never commit a certificate or its password. On Windows, copy the base64 value to
the clipboard with:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\path\to\certificate.pfx')) | Set-Clipboard
```

If the value exceeds the Windows environment-variable limit, export the `.pfx`
again without intermediate certificates in its certification path.

## Build locally

Set the same two environment variables, then run:

```powershell
npm ci
npm test
npm run dist:win
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/verify-windows-signatures.ps1
```

`dist:win` deliberately fails when a signing identity is unavailable. Development
and pull-request CI can still create clearly labeled unsigned QA artifacts using
the direct `electron-builder` command in `.github/workflows/ci.yml`.

## Publish

1. Update `package.json` to the release version and merge the tested changes to
   `master`.
2. Run **Release Windows** with `workflow_dispatch` as a release-candidate check.
3. Confirm the signature verifier reports the expected certificate subject and
   thumbprint.
4. Push a matching tag such as `v1.6.0`.
5. Verify the GitHub release contains both `Inwise-Setup-1.6.0.exe` and
   `Inwise-Setup-Windows.exe`.
6. Download the stable installer on a clean Windows 10/11 machine, open its
   Properties, and confirm **Digital Signatures** shows the expected publisher.

A standard organization-validation certificate removes the **Unknown publisher**
label, but Microsoft SmartScreen may still warn until the certificate builds
download reputation. An EV certificate or Microsoft Trusted Signing can provide
immediate reputation if that is required.
