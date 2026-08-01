# @inwise/desktop-shared

Shared TypeScript interfaces and local audio utilities used by the Inwise desktop application.

This package is intentionally committed inside the public repository. A fresh clone can install, test, and build Inwise without access to a separate private repository or Git submodule.

## Contents

- Adapter interfaces for data, authentication, and transcription backends
- Renderer-agnostic WAV and channel-processing utilities
- MFCC voice-embedding and speaker-matching utilities

## Development

From this directory:

```shell
npm ci
npm run typecheck
npm run build
```

The package is private to prevent accidental registry publication. It is consumed by the root application through the `file:src/shared` dependency and is covered by the repository's MIT license.
