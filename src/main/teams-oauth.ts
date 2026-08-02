import * as crypto from 'crypto';
import { shell } from 'electron';
import {
  clearOAuthCredentials,
  getOAuthCredentials,
  setOAuthClientCredentials,
  setOAuthTokens,
} from './database';
import { log } from './logger';
import { createPkcePair, waitForOAuthCode } from './oauth-loopback';
import {
  buildTeamsAuthorizationUrl,
  formatTeamsOAuthError,
  normalizeTeamsTenant,
  TEAMS_GRAPH_SCOPES,
  TEAMS_OAUTH_PORT,
  TEAMS_REDIRECT_URI,
} from './teams-oauth-config';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';

interface MicrosoftTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export async function saveTeamsCredentials(clientId: string, tenant?: string): Promise<void> {
  const normalizedClientId = clientId.trim();
  if (!normalizedClientId) throw new Error('Microsoft application (client) ID is required');
  const normalizedTenant = normalizeTeamsTenant(tenant);
  await setOAuthClientCredentials('teams', {
    clientId: normalizedClientId,
    tenant: normalizedTenant === 'organizations' ? null : normalizedTenant,
  });
}

function tokenEndpoint(tenant?: string | null): string {
  return `https://login.microsoftonline.com/${normalizeTeamsTenant(tenant)}/oauth2/v2.0/token`;
}

async function readTokenResponse(response: Response): Promise<MicrosoftTokenResponse> {
  const text = await response.text();
  let data: MicrosoftTokenResponse;
  try {
    data = JSON.parse(text) as MicrosoftTokenResponse;
  } catch {
    throw new Error(`Microsoft token service returned HTTP ${response.status}`);
  }
  if (!response.ok || !data.access_token) {
    throw new Error(formatTeamsOAuthError(data.error_description || data.error || `HTTP ${response.status}`));
  }
  return data;
}

export async function connectTeams(): Promise<{ ok: boolean; error?: string }> {
  const credentials = await getOAuthCredentials('teams');
  if (!credentials?.clientId) {
    return { ok: false, error: 'Enter and save your Microsoft application ID first.' };
  }

  const state = crypto.randomBytes(16).toString('hex');
  const pkce = createPkcePair();
  const authorizationUrl = buildTeamsAuthorizationUrl({
    clientId: credentials.clientId,
    tenant: credentials.tenant,
    state,
    codeChallenge: pkce.challenge,
  });
  const callback = await waitForOAuthCode({
    port: TEAMS_OAUTH_PORT,
    redirectUri: TEAMS_REDIRECT_URI,
    state,
    providerName: 'Microsoft Teams',
    authorizationUrl,
    openExternal: (url) => shell.openExternal(url),
  });
  if (!callback.ok) return { ok: false, error: formatTeamsOAuthError(callback.error) };

  try {
    const body = new URLSearchParams({
      client_id: credentials.clientId,
      grant_type: 'authorization_code',
      code: callback.code,
      redirect_uri: TEAMS_REDIRECT_URI,
      code_verifier: pkce.verifier,
      scope: TEAMS_GRAPH_SCOPES.join(' '),
    });
    const response = await fetch(tokenEndpoint(credentials.tenant), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const token = await readTokenResponse(response);
    await setOAuthTokens('teams', {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || '',
      tokenExpiresAt: new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString(),
    });
    log('info', 'teams:connected', 'tokens stored');
    return { ok: true };
  } catch (error: any) {
    log('error', 'teams:connect-failed', error.message);
    return { ok: false, error: error.message };
  }
}

export async function getValidTeamsToken(): Promise<string> {
  const credentials = await getOAuthCredentials('teams');
  if (!credentials?.accessToken || !credentials.clientId) throw new Error('Microsoft Teams is not connected');

  const expiresAt = credentials.tokenExpiresAt ? Date.parse(credentials.tokenExpiresAt) : 0;
  if (expiresAt > Date.now() + 5 * 60 * 1000) return credentials.accessToken;
  if (!credentials.refreshToken) throw new Error('Microsoft Teams authorization expired. Reconnect in Settings.');

  const body = new URLSearchParams({
    client_id: credentials.clientId,
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
    scope: TEAMS_GRAPH_SCOPES.join(' '),
  });
  const response = await fetch(tokenEndpoint(credentials.tenant), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const token = await readTokenResponse(response);
  await setOAuthTokens('teams', {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || credentials.refreshToken,
    tokenExpiresAt: new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString(),
  });
  return token.access_token;
}

export async function getTeamsStatus(): Promise<{ connected: boolean; configured: boolean }> {
  const credentials = await getOAuthCredentials('teams');
  return { connected: !!credentials?.accessToken, configured: !!credentials?.clientId };
}

export async function testTeamsConnection(): Promise<{ ok: boolean; error?: string }> {
  try {
    const token = await getValidTeamsToken();
    const response = await fetch(`${GRAPH_API}/me?$select=id,displayName`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) return { ok: true };
    return { ok: false, error: `Microsoft Graph returned HTTP ${response.status}: ${await response.text()}` };
  } catch (error: any) {
    return { ok: false, error: error.message };
  }
}

export async function disconnectTeams(): Promise<void> {
  await clearOAuthCredentials('teams');
  log('info', 'teams:disconnected', 'credentials cleared');
}

export const TEAMS_REDIRECT_URI_DISPLAY = TEAMS_REDIRECT_URI;
