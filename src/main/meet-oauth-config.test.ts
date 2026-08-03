import * as assert from 'node:assert/strict';
import {
  buildMeetAuthorizationUrl,
  formatMeetOAuthError,
  MEET_READ_SCOPE,
  MEET_REDIRECT_URI,
} from './meet-oauth-config';

async function run(): Promise<void> {
  const url = new URL(buildMeetAuthorizationUrl({
    clientId: 'google-client',
    state: 'state-value',
    codeChallenge: 'challenge-value',
  }));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('redirect_uri'), MEET_REDIRECT_URI);
  assert.equal(url.searchParams.get('scope'), MEET_READ_SCOPE);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(formatMeetOAuthError('invalid_client'), /Desktop app/i);
  assert.match(formatMeetOAuthError('access_denied'), /test user|Internal/i);

  console.log('meet-oauth-config: all tests passed');
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { run };
