import assert from 'node:assert/strict';
import {
  buildZoomAuthorizationUrl,
  parseZoomOAuthCallback,
  ZOOM_OAUTH_TIMEOUT_MS,
  ZOOM_REDIRECT_URI,
} from './zoom-oauth-config';

assert.equal(
  ZOOM_REDIRECT_URI,
  'http://127.0.0.1:17292/callback',
  'the desktop callback must match the Zoom Marketplace allowlist exactly',
);

const authorizationUrl = new URL(buildZoomAuthorizationUrl({
  clientId: 'public-client-id',
  state: 'oauth-state',
  codeChallenge: 'pkce-challenge',
}));

assert.equal(authorizationUrl.origin, 'https://zoom.us');
assert.equal(authorizationUrl.pathname, '/oauth/authorize');
assert.equal(authorizationUrl.searchParams.get('redirect_uri'), ZOOM_REDIRECT_URI);
assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
assert.equal(ZOOM_OAUTH_TIMEOUT_MS, 10 * 60 * 1000);

assert.deepEqual(
  parseZoomOAuthCallback('/callback?code=stale&state=old', 'current'),
  { kind: 'state-mismatch' },
  'a stale browser retry must not cancel the current OAuth listener',
);
assert.deepEqual(
  parseZoomOAuthCallback('/callback?code=fresh&state=current', 'current'),
  { kind: 'code', code: 'fresh' },
);
assert.deepEqual(
  parseZoomOAuthCallback('/callback?error=access_denied&state=current', 'current'),
  { kind: 'oauth-error', error: 'access_denied' },
);

console.log('zoom-oauth-config tests passed');
