export const TEAMS_OAUTH_PORT = 17293;
// This must exactly match the redirect registered on the public client. The
// callback server still binds to the IPv4 loopback interface only.
export const TEAMS_REDIRECT_URI = `http://localhost:${TEAMS_OAUTH_PORT}/callback`;
export const TEAMS_GRAPH_SCOPES = [
  'openid',
  'profile',
  'offline_access',
  'User.Read',
  'Calendars.Read',
  'OnlineMeetings.Read',
  'OnlineMeetingTranscript.Read.All',
] as const;

export function normalizeTeamsTenant(tenant?: string | null): string {
  const value = tenant?.trim() || 'organizations';
  if (!/^[A-Za-z0-9.-]+$/.test(value)) {
    throw new Error('Microsoft tenant must be a tenant ID or verified domain name');
  }
  return value;
}
export function buildTeamsAuthorizationUrl(options: {
  clientId: string;
  tenant?: string | null;
  state: string;
  codeChallenge: string;
}): string {
  const tenant = normalizeTeamsTenant(options.tenant);
  const url = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
  url.search = new URLSearchParams({
    client_id: options.clientId,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: TEAMS_REDIRECT_URI,
    scope: TEAMS_GRAPH_SCOPES.join(' '),
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

export function formatTeamsOAuthError(detail: string): string {
  if (/AADSTS65001|consent_required|admin approval/i.test(detail)) {
    return 'Your Microsoft 365 administrator must approve Inwise\'s Teams transcript permission before this account can connect.';
  }
  if (/AADSTS50020|personal Microsoft account/i.test(detail)) {
    return 'Teams transcript import requires a Microsoft 365 work or school account; personal Microsoft accounts are not supported by this Graph API.';
  }
  return detail;
}
