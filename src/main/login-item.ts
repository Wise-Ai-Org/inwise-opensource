export interface LoginItemRegistration {
  openAtLogin: boolean;
  args?: string[];
}

export interface LoginItemLaunchState {
  wasOpenedAtLogin?: boolean;
  wasOpenedAsHidden?: boolean;
}

/**
 * macOS 13+ no longer supports openAsHidden, so the app detects a login launch
 * and suppresses its popup itself. Windows retains the explicit --hidden arg.
 */
export function createLoginItemRegistration(
  platform: NodeJS.Platform | string,
  openAtLogin: boolean,
): LoginItemRegistration {
  return platform === 'darwin'
    ? { openAtLogin }
    : { openAtLogin, args: ['--hidden'] };
}

export function shouldStartHidden(
  platform: NodeJS.Platform | string,
  cliRequestedHidden: boolean,
  launchState: LoginItemLaunchState = {},
): boolean {
  if (cliRequestedHidden) return true;
  return platform === 'darwin' &&
    (!!launchState.wasOpenedAtLogin || !!launchState.wasOpenedAsHidden);
}
