import * as assert from 'node:assert/strict';
import { createPkcePair, parseOAuthCallback } from './oauth-loopback';

async function run(): Promise<void> {
  const pkce = createPkcePair();
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(pkce.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(pkce.verifier, pkce.challenge);

  const redirectUri = 'http://127.0.0.1:17293/callback';
  assert.deepEqual(parseOAuthCallback('/health', redirectUri, 'expected'), { kind: 'not-callback' });
  assert.deepEqual(parseOAuthCallback('/callback-old?code=bad&state=expected', redirectUri, 'expected'), { kind: 'not-callback' });
  assert.deepEqual(
    parseOAuthCallback('/callback?code=old&state=stale', redirectUri, 'expected'),
    { kind: 'state-mismatch' },
  );
  assert.deepEqual(
    parseOAuthCallback('/callback?code=fresh&state=expected', redirectUri, 'expected'),
    { kind: 'code', code: 'fresh' },
  );
  assert.deepEqual(
    parseOAuthCallback('/callback?error=access_denied&error_description=User+cancelled&state=expected', redirectUri, 'expected'),
    { kind: 'oauth-error', error: 'User cancelled' },
  );

  console.log('oauth-loopback: all tests passed');
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { run };
