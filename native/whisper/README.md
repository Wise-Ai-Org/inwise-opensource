# Bundled whisper.cpp runtime

Mac release builds compile the pinned `whisper.cpp` CLI with static libraries and
an embedded Metal shader, then place it in one of these generated directories:

- `darwin-arm64/whisper-cli`
- `darwin-x64/whisper-cli`

Run `npm run build:whisper:mac` on the matching Mac architecture. Release CI
does this before electron-builder packages the binary into
`Inwise.app/Contents/Resources/whisper/`.

The pinned version is defined once in `src/main/whisper-runtime-config.json`
and is shared by the Windows downloader and macOS build script.

`GGML_NATIVE` is disabled so each artifact is portable across supported Macs of
the same architecture. The upstream MIT license is copied beside the binary.

The generated executables and build tree are intentionally ignored. Windows
continues to download the official pinned x64 release on first run.
