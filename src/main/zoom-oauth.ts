import * as http from 'http';
import * as crypto from 'crypto';
import { shell } from 'electron';
import { log } from './logger';
import {
  getZoomCredentials,
  setZoomClientCredentials,
  setZoomTokens,
  clearZoomCredentials,
} from './database';

const ZOOM_OAUTH_PORT = 17292;
const ZOOM_REDIRECT_URI = `http://localhost:${ZOOM_OAUTH_PORT}/callback`;
const ZOOM_AUTH_URL = 'https://zoom.us/oauth/authorize';
const ZOOM_TOKEN_URL = 'https://zoom.us/oauth/token';

export const ZOOM_REDIRECT_URI_DISPLAY = ZOOM_REDIRECT_URI;

export async function saveZoomCredentials(clientId: string, clientSecret: string): Promise<void> {
  await setZoomClientCredentials(clientId, clientSecret);
}

export async function connectZoom(): Promise<{ ok: boolean; error?: string }> {
  const creds = await getZoomCredentials();
  if (!creds?.zoomClientId || !creds?.zoomClientSecret) {
    return { ok: false, error: 'Zoom Client ID and Secret must be saved first' };
  }

  const { zoomClientId: clientId, zoomClientSecret: clientSecret } = creds;
  const state = crypto.randomBytes(16).toString('hex');

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith('/callback')) {
        res.writeHead(404); res.end(); return;
      }

      const url = new URL(req.url, 'http://localhost');
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      if (!code || returnedState !== state) {
        res.writeHead(400); res.end('Invalid OAuth callback');
        server.close();
        resolve({ ok: false, error: 'OAuth state mismatch or missing code' });
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Zoom Connected!</h2><p>You can close this tab and return to Inwise.</p></body></html>');

      try {
        const basicCreds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const tokenRes = await fetch(ZOOM_TOKEN_URL, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${basicCreds}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: ZOOM_REDIRECT_URI,
          }),
        });

        if (!tokenRes.ok) {
          const err = await tokenRes.text();
          log('error', 'zoom:token-exchange', err);
          server.close();
          resolve({ ok: false, error: 'Token exchange failed' });
          return;
        }

        const tokenData = await tokenRes.json() as any;
        const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString();

        await setZoomTokens({
          zoomAccessToken: tokenData.access_token,
          zoomRefreshToken: tokenData.refresh_token,
          zoomTokenExpiresAt: expiresAt,
        });

        log('info', 'zoom:connected', 'tokens stored');
        server.close();
        resolve({ ok: true });
      } catch (e: any) {
        log('error', 'zoom:connect-failed', e.message);
        server.close();
        resolve({ ok: false, error: e.message });
      }
    });

    server.listen(ZOOM_OAUTH_PORT, () => {
      const authUrl =
        `${ZOOM_AUTH_URL}?response_type=code` +
        `&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(ZOOM_REDIRECT_URI)}` +
        `&state=${state}`;
      shell.openExternal(authUrl);
      log('info', 'zoom:oauth-started', 'opened browser for authorization');
    });

    setTimeout(() => {
      server.close();
      resolve({ ok: false, error: 'OAuth timed out — please try again' });
    }, 5 * 60 * 1000);
  });
}

export async function disconnectZoom(): Promise<void> {
  await clearZoomCredentials();
  log('info', 'zoom:disconnected', 'credentials cleared');
}

export async function getZoomStatus(): Promise<{ connected: boolean }> {
  const creds = await getZoomCredentials();
  return { connected: !!(creds?.zoomAccessToken) };
}

export async function getValidZoomToken(): Promise<string> {
  const creds = await getZoomCredentials();
  if (!creds?.zoomAccessToken) throw new Error('Zoom not connected');

  if (creds.zoomTokenExpiresAt) {
    const expiresAt = new Date(creds.zoomTokenExpiresAt).getTime();
    if (expiresAt > Date.now() + 5 * 60 * 1000) {
      return creds.zoomAccessToken;
    }
  }

  if (!creds.zoomClientId || !creds.zoomClientSecret || !creds.zoomRefreshToken) {
    throw new Error('Cannot refresh — missing credentials or refresh token');
  }

  const basicCreds = Buffer.from(`${creds.zoomClientId}:${creds.zoomClientSecret}`).toString('base64');
  const res = await fetch(ZOOM_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicCreds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.zoomRefreshToken,
    }),
  });

  if (!res.ok) throw new Error('Zoom token refresh failed — please reconnect');

  const data = await res.json() as any;
  const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();

  await setZoomTokens({
    zoomAccessToken: data.access_token,
    zoomRefreshToken: data.refresh_token || creds.zoomRefreshToken,
    zoomTokenExpiresAt: expiresAt,
  });

  log('info', 'zoom:token-refreshed', 'access token renewed');
  return data.access_token;
}

export async function testZoomConnection(): Promise<{ ok: boolean; error?: string }> {
  try {
    const token = await getValidZoomToken();
    const res = await fetch('https://api.zoom.us/v2/users/me/recordings?page_size=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return { ok: true };
    const body = await res.text();
    return { ok: false, error: `HTTP ${res.status}: ${body}` };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
