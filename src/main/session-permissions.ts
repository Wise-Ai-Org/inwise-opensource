import type { DesktopCapturerSource, Session, WebContents } from 'electron';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Keep this allowlist aligned with APIs the renderer actually uses. Permission
// requests from OAuth pages or any other remote content are still rejected by
// the trusted-renderer check below.
const TRUSTED_RENDERER_REQUEST_PERMISSIONS = new Set([
  'media',
  'display-capture',
  'speaker-selection',
  'clipboard-sanitized-write',
]);
const TRUSTED_RENDERER_CHECK_PERMISSIONS = new Set([
  'media',
  'clipboard-sanitized-write',
]);

export function isTrustedRendererUrl(urlValue: string, rendererDirectory: string): boolean {
  try {
    const url = new URL(urlValue);
    if (url.protocol === 'app:' && url.hostname === 'bundle') return true;
    if (url.protocol !== 'file:') return false;

    const rendererRoot = path.resolve(rendererDirectory);
    const requestedPath = path.resolve(fileURLToPath(url));
    const relative = path.relative(rendererRoot, requestedPath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

function isTrustedWebContents(webContents: WebContents | null, rendererDirectory: string): boolean {
  return !!webContents && isTrustedRendererUrl(webContents.getURL(), rendererDirectory);
}

export function installSessionPermissionHandlers(session: Session, rendererDirectory: string): void {
  session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(
      TRUSTED_RENDERER_REQUEST_PERMISSIONS.has(permission) &&
      isTrustedWebContents(webContents, rendererDirectory),
    );
  });

  session.setPermissionCheckHandler((webContents, permission) => {
    return TRUSTED_RENDERER_CHECK_PERMISSIONS.has(permission) &&
      isTrustedWebContents(webContents, rendererDirectory);
  });
}

export type DisplaySourceProvider = () => Promise<DesktopCapturerSource | null>;

export function installDisplayMediaHandler(
  session: Session,
  rendererDirectory: string,
  getDisplaySource: DisplaySourceProvider,
): void {
  session.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!request.frame || !isTrustedRendererUrl(request.frame.url, rendererDirectory)) {
      callback({});
      return;
    }

    try {
      const source = await getDisplaySource();
      callback(source ? { video: source, audio: 'loopback' } : {});
    } catch {
      callback({});
    }
  }, { useSystemPicker: false });
}
