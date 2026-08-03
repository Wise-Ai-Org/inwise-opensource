import * as crypto from 'crypto';
import * as http from 'http';

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export type OAuthCallbackResult =
  | { kind: 'not-callback' }
  | { kind: 'state-mismatch' }
  | { kind: 'oauth-error'; error: string }
  | { kind: 'code'; code: string };

export type OAuthLoopbackResult =
  | { ok: true; code: string }
  | { ok: false; error: string };

export function createPkcePair(): PkcePair {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function parseOAuthCallback(
  requestUrl: string | undefined,
  redirectUri: string,
  expectedState: string,
): OAuthCallbackResult {
  if (!requestUrl) return { kind: 'not-callback' };

  const url = new URL(requestUrl, redirectUri);
  if (url.pathname !== new URL(redirectUri).pathname) return { kind: 'not-callback' };
  if (url.searchParams.get('state') !== expectedState) {
    return { kind: 'state-mismatch' };
  }

  const code = url.searchParams.get('code');
  if (code) return { kind: 'code', code };

  return {
    kind: 'oauth-error',
    error: url.searchParams.get('error_description')
      || url.searchParams.get('error')
      || 'Authorization did not return a code',
  };
}

function callbackHtml(providerName: string): string {
  const safeName = providerName.replace(/[<>&"']/g, '');
  return `<!doctype html><html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>${safeName} authorization received</h2><p>You can close this tab and return to Inwise.</p></body></html>`;
}

export function waitForOAuthCode(options: {
  port: number;
  redirectUri: string;
  state: string;
  providerName: string;
  authorizationUrl: string;
  openExternal: (url: string) => Promise<unknown>;
  timeoutMs?: number;
}): Promise<OAuthLoopbackResult> {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;

  return new Promise((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;

    const finish = (result: OAuthLoopbackResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (server.listening) server.close();
      resolve(result);
    };

    const server = http.createServer((req, res) => {
      const callback = parseOAuthCallback(req.url, options.redirectUri, options.state);

      if (callback.kind === 'not-callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      // A browser can retry an old loopback URL after a fresh OAuth attempt has
      // started. Reject that request without cancelling the active listener.
      if (callback.kind === 'state-mismatch') {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('This authorization link is stale. Return to Inwise and use the newest browser tab.');
        return;
      }

      if (callback.kind === 'oauth-error') {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Authorization failed: ${callback.error}`);
        finish({ ok: false, error: callback.error });
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(callbackHtml(options.providerName));
      finish({ ok: true, code: callback.code });
    });

    server.once('error', (error: NodeJS.ErrnoException) => {
      const detail = error.code === 'EADDRINUSE'
        ? `Local OAuth port ${options.port} is already in use. Close the other app or authorization attempt and try again.`
        : error.message;
      finish({ ok: false, error: detail });
    });

    server.listen(options.port, '127.0.0.1', () => {
      options.openExternal(options.authorizationUrl).catch((error: any) => {
        finish({ ok: false, error: error?.message || 'Could not open the authorization page' });
      });
    });

    timeout = setTimeout(() => {
      finish({ ok: false, error: 'Authorization timed out. Please try again.' });
    }, timeoutMs);
  });
}
