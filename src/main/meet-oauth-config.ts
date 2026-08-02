export const MEET_OAUTH_PORT = 17294;
export const MEET_REDIRECT_URI = `http://127.0.0.1:${MEET_OAUTH_PORT}/callback`;
export const MEET_READ_SCOPE = 'https://www.googleapis.com/auth/meetings.space.readonly';

export function buildMeetAuthorizationUrl(options: {
  clientId: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: options.clientId,
    response_type: 'code',
    redirect_uri: MEET_REDIRECT_URI,
    scope: MEET_READ_SCOPE,
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  }).toString();
  return url.toString();
}
export function formatMeetOAuthError(detail: string): string {
  if (/access_denied|not been completed|not configured for access|Error 403/i.test(detail)) {
    return 'Google blocked access to this OAuth app. Add your account as a test user, or use an Internal consent screen in your Google Workspace organization.';
  }
  if (/invalid_client/i.test(detail)) {
    return 'Google rejected the client ID or secret. Use credentials whose application type is Desktop app.';
  }
  if (/invalid_grant/i.test(detail)) {
    return 'Google authorization expired or was revoked. Reconnect Google Meet in Settings.';
  }
  return detail;
}
