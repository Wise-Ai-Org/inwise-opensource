import * as http from 'http';
import { shell } from 'electron';
import { getConfig } from './config';

const REDIRECT_PORT = 3579;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

interface AuthResult {
  provider: 'google' | 'microsoft';
  accessToken: string;
  email: string;
  name: string;
}

function startLoopbackServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${REDIRECT_PORT}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (code) {
        res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f8fafc">
          <div style="font-size:48px;color:#0d9488">✓</div>
          <h2 style="color:#0f172a">Signed in successfully</h2>
          <p style="color:#64748b">You can close this tab and return to inWise.</p>
          </body></html>`);
        server.close();
        resolve(code);
      } else {
        res.end(`<html><body>Error: ${error || 'unknown'}</body></html>`);
        server.close();
        reject(new Error(error || 'OAuth error'));
      }
    });

    server.listen(REDIRECT_PORT, '127.0.0.1');
    server.on('error', reject);

    setTimeout(() => {
      server.close();
      reject(new Error('OAuth timeout'));
    }, 5 * 60 * 1000);
  });
}

export async function loginWithGoogle(): Promise<AuthResult> {
  const config = getConfig();
  if (!config.googleClientId || !config.googleClientSecret) {
    throw new Error('Google Client ID and Secret are required. Please complete setup in Settings.');
  }

  const scopes = [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/calendar.readonly',
  ].join(' ');

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(config.googleClientId)}&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `response_type=code&` +
    `scope=${encodeURIComponent(scopes)}&` +
    `access_type=offline&` +
    `prompt=consent`;

  const codePromise = startLoopbackServer();
  await shell.openExternal(authUrl);
  const code = await codePromise;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  const tokenData = await tokenRes.json() as any;
  if (!tokenData.access_token) throw new Error('Failed to get access token');

  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const user = await userRes.json() as any;

  return {
    provider: 'google',
    accessToken: tokenData.access_token,
    email: user.email,
    name: user.name,
  };
}

export async function loginWithMicrosoft(): Promise<AuthResult> {
  const config = getConfig();
  if (!config.microsoftClientId) {
    throw new Error('Microsoft Client ID is required. Please complete setup in Settings.');
  }

  const { PublicClientApplication } = await import('@azure/msal-node');
  const msalApp = new PublicClientApplication({
    auth: {
      clientId: config.microsoftClientId,
      authority: 'https://login.microsoftonline.com/common',
    },
  });

  const scopes = [
    'openid', 'profile', 'email',
    'Calendars.Read',
    'offline_access',
  ];

  const authCodeRequest = {
    scopes,
    redirectUri: REDIRECT_URI,
  };

  const authUrl = await msalApp.getAuthCodeUrl(authCodeRequest);
  const codePromise = startLoopbackServer();
  await shell.openExternal(authUrl);
  const code = await codePromise;

  const tokenResult = await msalApp.acquireTokenByCode({ ...authCodeRequest, code });
  if (!tokenResult) throw new Error('Failed to acquire token');

  return {
    provider: 'microsoft',
    accessToken: tokenResult.accessToken,
    email: tokenResult.account?.username || '',
    name: tokenResult.account?.name || '',
  };
}
