export const ZOOM_OAUTH_PORT = 17292;

// This must remain byte-identical to the redirect URL registered for the
// Inwise public client in Zoom Marketplace. Zoom treats localhost and
// 127.0.0.1 as different redirect URLs and rejects a mismatch before consent.
export const ZOOM_REDIRECT_URI = `http://127.0.0.1:${ZOOM_OAUTH_PORT}/callback`;
export const ZOOM_OAUTH_TIMEOUT_MS = 10 * 60 * 1000;

export type ZoomOAuthCallback =
  | { kind: 'not-callback' }
  | { kind: 'state-mismatch' }
  | { kind: 'oauth-error'; error: string }
  | { kind: 'code'; code: string };

export function parseZoomOAuthCallback(
  requestUrl: string | undefined,
  expectedState: string,
): ZoomOAuthCallback {
  if (!requestUrl?.startsWith('/callback')) return { kind: 'not-callback' };

  const url = new URL(requestUrl, ZOOM_REDIRECT_URI);
  if (url.searchParams.get('state') !== expectedState) {
    return { kind: 'state-mismatch' };
  }

  const code = url.searchParams.get('code');
  if (code) return { kind: 'code', code };

  return {
    kind: 'oauth-error',
    error: url.searchParams.get('error_description')
      || url.searchParams.get('error')
      || 'Zoom authorization did not return a code',
  };
}

export function buildZoomAuthorizationUrl(params: {
  clientId: string;
  state: string;
  codeChallenge?: string;
}): string {
  const url = new URL('https://zoom.us/oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', ZOOM_REDIRECT_URI);
  url.searchParams.set('state', params.state);
  if (params.codeChallenge) {
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}
