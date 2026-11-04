import * as fs from 'fs';
import * as path from 'path';

export interface MeetDesktopClient { clientId: string; clientSecret: string }
/** Installed-app client configuration is distributable, not a confidential server secret.
 * User access and refresh tokens are never included in this file. */
export function readMeetDesktopClient(file = path.join(__dirname, '../../assets/google-oauth-client.json')): MeetDesktopClient | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof value.clientId !== 'string' || !/^[\w-]+\.apps\.googleusercontent\.com$/.test(value.clientId) ||
        typeof value.clientSecret !== 'string' || !value.clientSecret.trim()) return null;
    return { clientId: value.clientId, clientSecret: value.clientSecret };
  } catch { return null; }
}
