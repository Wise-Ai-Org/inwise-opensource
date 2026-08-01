import * as path from 'path';
import runtimeConfig from './whisper-runtime-config.json';

export const WHISPER_VERSION = runtimeConfig.version;
export const WINDOWS_WHISPER_URL =
  `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-x64.zip`;

export type InwiseDesktopPlatform = 'win32' | 'darwin';
export type InwiseDesktopArch = 'x64' | 'arm64';

export interface WhisperRuntimeContext {
  platform: NodeJS.Platform | string;
  arch: string;
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  userDataPath: string;
}

export interface WhisperRuntimePlan {
  platform: InwiseDesktopPlatform;
  arch: InwiseDesktopArch;
  binaryCandidates: string[];
  installDir: string;
  downloadUrl: string | null;
  archivePath: string | null;
}

function requirePlatform(platform: string): InwiseDesktopPlatform {
  if (platform === 'win32' || platform === 'darwin') return platform;
  throw new Error(`Inwise local transcription is not available on ${platform}`);
}

function requireArch(arch: string): InwiseDesktopArch {
  if (arch === 'x64' || arch === 'arm64') return arch;
  throw new Error(`Inwise local transcription is not available on ${arch}`);
}

/**
 * Pure platform resolver for the native whisper.cpp CLI.
 *
 * Windows preserves the existing first-run download. macOS uses the binary
 * built for the app's exact architecture and bundled in Contents/Resources;
 * development runs use the same artifact from native/whisper/.
 */
export function createWhisperRuntimePlan(context: WhisperRuntimeContext): WhisperRuntimePlan {
  const platform = requirePlatform(context.platform);
  const arch = requireArch(context.arch);

  if (platform === 'win32') {
    if (arch !== 'x64') {
      throw new Error('The Windows release currently supports x64 only');
    }
    const installDir = path.join(context.userDataPath, 'whisper-bin');
    return {
      platform,
      arch,
      binaryCandidates: [
        path.join(installDir, 'Release', 'whisper-cli.exe'),
        path.join(installDir, 'Release', 'main.exe'),
      ],
      installDir,
      downloadUrl: WINDOWS_WHISPER_URL,
      archivePath: path.join(installDir, 'whisper-bin.zip'),
    };
  }

  const bundled = path.join(context.resourcesPath, 'whisper', 'whisper-cli');
  const development = path.join(context.appPath, 'native', 'whisper', `darwin-${arch}`, 'whisper-cli');
  return {
    platform,
    arch,
    binaryCandidates: context.isPackaged ? [bundled] : [development, bundled],
    installDir: path.dirname(context.isPackaged ? bundled : development),
    downloadUrl: null,
    archivePath: null,
  };
}
