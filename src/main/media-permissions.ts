import { shell, systemPreferences } from 'electron';

export type MediaPermissionStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';
export type MediaSettingsKind = 'microphone' | 'screen';

export interface MediaPermissionSnapshot {
  platform: NodeJS.Platform;
  microphone: MediaPermissionStatus;
  screen: MediaPermissionStatus;
}
function status(mediaType: 'microphone' | 'screen'): MediaPermissionStatus {
  try {
    return systemPreferences.getMediaAccessStatus(mediaType) as MediaPermissionStatus;
  } catch {
    return 'unknown';
  }
}

export function getMediaPermissions(): MediaPermissionSnapshot {
  return {
    platform: process.platform,
    microphone: status('microphone'),
    screen: status('screen'),
  };
}

export async function requestMicrophonePermission(): Promise<MediaPermissionSnapshot> {
  if (process.platform === 'darwin' && status('microphone') === 'not-determined') {
    await systemPreferences.askForMediaAccess('microphone');
  }
  return getMediaPermissions();
}

export async function openMediaSettings(kind: MediaSettingsKind): Promise<void> {
  if (process.platform === 'darwin') {
    const pane = kind === 'microphone' ? 'Privacy_Microphone' : 'Privacy_ScreenCapture';
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
    return;
  }
  if (process.platform === 'win32') {
    await shell.openExternal(kind === 'microphone' ? 'ms-settings:privacy-microphone' : 'ms-settings:privacy');
  }
}
