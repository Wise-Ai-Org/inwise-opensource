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
// Zoom's redirect allowlist rejects the literal hostname "localhost" — it
// requires 127.0.0.1 (or [::1]). Must stay byte-identical to the value
// registered in the Zoom app, or the token exchange fails with invalid_grant.
const ZOOM_REDIRECT_URI = `http://127.0.0.1:${ZOOM_OAUTH_PORT}/callback`;
const ZOOM_AUTH_URL = 'https://zoom.us/oauth/authorize';
const ZOOM_TOKEN_URL = 'https://zoom.us/oauth/token';

// Public client ids of the Inwise Zoom Marketplace app. Safe to ship in MIT
// source: they are public by design — PKCE replaces the client secret, so
// there is no secret in this flow at all. The dev id authorizes while the
// Marketplace app is unpublished; switch the default to the production id
// once Zoom publishes the app. Forks can point at their own Zoom app via
// INWISE_ZOOM_PUBLIC_CLIENT_ID or the BYO-credentials path in Settings.
const ZOOM_PUBLIC_CLIENT_ID_DEV = 'pq0Gg4OSFa89B3miW92fA';
export const ZOOM_PUBLIC_CLIENT_ID_PROD = 'M9fK63XqSCa6nZGUXPAqPg';
const ZOOM_PUBLIC_CLIENT_ID =
  process.env.INWISE_ZOOM_PUBLIC_CLIENT_ID || ZOOM_PUBLIC_CLIENT_ID_DEV;

export const ZOOM_REDIRECT_URI_DISPLAY = ZOOM_REDIRECT_URI;

export async function saveZoomCredentials(clientId: string, clientSecret: string): Promise<void> {
  await setZoomClientCredentials(clientId, clientSecret);
}

export async function connectZoom(): Promise<{ ok: boolean; error?: string }> {
  const creds = await getZoomCredentials();
  // BYO credentials (user's own Zoom app) take precedence when both fields are
  // saved; otherwise fall back to the embedded public client with PKCE — the
  // zero-setup default.
  const byo = !!(creds?.zoomClientId && creds?.zoomClientSecret);
  const clientId = byo ? creds!.zoomClientId! : ZOOM_PUBLIC_CLIENT_ID;
  const clientSecret = byo ? creds!.zoomClientSecret! : null;
  const state = crypto.randomBytes(16).toString('hex');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

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
        // BYO apps authenticate with Basic client_id:secret; the public client
        // proves itself with the PKCE code_verifier instead (no auth header).
        const headers: Record<string, string> = {
          'Content-Type': 'application/x-www-form-urlencoded',
        };
        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: ZOOM_REDIRECT_URI,
        });
        if (clientSecret) {
          headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
        } else {
          body.set('client_id', clientId);
          body.set('code_verifier', codeVerifier);
        }
        const tokenRes = await fetch(ZOOM_TOKEN_URL, { method: 'POST', headers, body });

        if (!tokenRes.ok) {
          const err = await tokenRes.text();
          log('error', 'zoom:token-exchange', err);
          server.close();
          resolve({ ok: false, error: 'Token exchange failed' });
          return;
        }

        const tokenData = await tokenRes.json() as any;
        const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString();

        if (!byo) {
          // Record which public client id minted these tokens (empty secret =
          // public client) so getValidZoomToken refreshes against the same app.
          await setZoomClientCredentials(clientId, '');
        }
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
      let authUrl =
        `${ZOOM_AUTH_URL}?response_type=code` +
        `&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(ZOOM_REDIRECT_URI)}` +
        `&state=${state}`;
      if (!byo) {
        authUrl += `&code_challenge=${codeChallenge}&code_challenge_method=S256`;
      }
      shell.openExternal(authUrl);
      log('info', 'zoom:oauth-started', `opened browser for authorization (${byo ? 'byo app' : 'public client'})`);
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

  if (!creds.zoomClientId || !creds.zoomRefreshToken) {
    throw new Error('Cannot refresh — missing credentials or refresh token');
  }

  // Empty/absent secret = tokens were minted by the public client (PKCE);
  // refresh with client_id in the body. A saved secret = BYO app; Basic auth.
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.zoomRefreshToken,
  });
  if (creds.zoomClientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${creds.zoomClientId}:${creds.zoomClientSecret}`).toString('base64')}`;
  } else {
    body.set('client_id', creds.zoomClientId);
  }
  const res = await fetch(ZOOM_TOKEN_URL, { method: 'POST', headers, body });

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
