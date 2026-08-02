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
  buildMeetAuthorizationUrl,
  formatMeetOAuthError,
  MEET_OAUTH_PORT,
  MEET_READ_SCOPE,
  MEET_REDIRECT_URI,
} from './meet-oauth-config';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MEET_API = 'https://meet.googleapis.com/v2';

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export async function saveMeetCredentials(clientId: string, clientSecret: string): Promise<void> {
  const normalizedClientId = clientId.trim();
  const normalizedSecret = clientSecret.trim();
  if (!normalizedClientId || !normalizedSecret) {
    throw new Error('Google Desktop client ID and client secret are required');
  }
  await setOAuthClientCredentials('meet', {
    clientId: normalizedClientId,
    clientSecret: normalizedSecret,
  });
}

async function readTokenResponse(response: Response): Promise<GoogleTokenResponse> {
  const text = await response.text();
  let data: GoogleTokenResponse;
  try {
    data = JSON.parse(text) as GoogleTokenResponse;
  } catch {
    throw new Error(`Google token service returned HTTP ${response.status}`);
  }
  if (!response.ok || !data.access_token) {
    throw new Error(formatMeetOAuthError(data.error_description || data.error || `HTTP ${response.status}`));
  }
  return data;
}

export async function connectMeet(): Promise<{ ok: boolean; error?: string }> {
  const credentials = await getOAuthCredentials('meet');
  if (!credentials?.clientId || !credentials.clientSecret) {
    return { ok: false, error: 'Enter and save your Google Desktop client ID and secret first.' };
  }

  const state = crypto.randomBytes(16).toString('hex');
  const pkce = createPkcePair();
  const authorizationUrl = buildMeetAuthorizationUrl({
    clientId: credentials.clientId,
    state,
    codeChallenge: pkce.challenge,
  });
  const callback = await waitForOAuthCode({
    port: MEET_OAUTH_PORT,
    redirectUri: MEET_REDIRECT_URI,
    state,
    providerName: 'Google Meet',
    authorizationUrl,
    openExternal: (url) => shell.openExternal(url),
  });
  if (!callback.ok) return { ok: false, error: formatMeetOAuthError(callback.error) };

  try {
    const body = new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: 'authorization_code',
      code: callback.code,
      redirect_uri: MEET_REDIRECT_URI,
      code_verifier: pkce.verifier,
    });
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const token = await readTokenResponse(response);
    await setOAuthTokens('meet', {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || '',
      tokenExpiresAt: new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString(),
    });
    log('info', 'meet:connected', 'tokens stored');
    return { ok: true };
  } catch (error: any) {
    log('error', 'meet:connect-failed', error.message);
    return { ok: false, error: error.message };
  }
}

export async function getValidMeetToken(): Promise<string> {
  const credentials = await getOAuthCredentials('meet');
  if (!credentials?.accessToken || !credentials.clientId || !credentials.clientSecret) {
    throw new Error('Google Meet is not connected');
  }

  const expiresAt = credentials.tokenExpiresAt ? Date.parse(credentials.tokenExpiresAt) : 0;
  if (expiresAt > Date.now() + 5 * 60 * 1000) return credentials.accessToken;
  if (!credentials.refreshToken) throw new Error('Google Meet authorization expired. Reconnect in Settings.');

  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
    scope: MEET_READ_SCOPE,
  });
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const token = await readTokenResponse(response);
  await setOAuthTokens('meet', {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || credentials.refreshToken,
    tokenExpiresAt: new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString(),
  });
  return token.access_token;
}

export async function getMeetStatus(): Promise<{ connected: boolean; configured: boolean }> {
  const credentials = await getOAuthCredentials('meet');
  return {
    connected: !!credentials?.accessToken,
    configured: !!(credentials?.clientId && credentials.clientSecret),
  };
}

export async function testMeetConnection(): Promise<{ ok: boolean; error?: string }> {
  try {
    const token = await getValidMeetToken();
    const response = await fetch(`${MEET_API}/conferenceRecords?pageSize=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) return { ok: true };
    return { ok: false, error: `Google Meet API returned HTTP ${response.status}: ${await response.text()}` };
  } catch (error: any) {
    return { ok: false, error: error.message };
  }
}

export async function disconnectMeet(): Promise<void> {
  const credentials = await getOAuthCredentials('meet');
  const token = credentials?.refreshToken || credentials?.accessToken;
  if (token) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    } catch {
      // Local disconnect still proceeds when Google is offline.
    }
  }
  await clearOAuthCredentials('meet');
  log('info', 'meet:disconnected', 'credentials cleared');
}

export const MEET_REDIRECT_URI_DISPLAY = MEET_REDIRECT_URI;
