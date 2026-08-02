import * as assert from 'node:assert/strict';
import {
  buildTeamsAuthorizationUrl,
  formatTeamsOAuthError,
  normalizeTeamsTenant,
  TEAMS_GRAPH_SCOPES,
  TEAMS_REDIRECT_URI,
} from './teams-oauth-config';

async function run(): Promise<void> {
  assert.equal(normalizeTeamsTenant(''), 'organizations');
  assert.equal(normalizeTeamsTenant('contoso.onmicrosoft.com'), 'contoso.onmicrosoft.com');
  assert.throws(() => normalizeTeamsTenant('../common?bad=true'));

  const url = new URL(buildTeamsAuthorizationUrl({
    clientId: 'client-id',
    state: 'state-value',
    codeChallenge: 'challenge-value',
  }));
  assert.equal(url.hostname, 'login.microsoftonline.com');
  assert.equal(url.pathname, '/organizations/oauth2/v2.0/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), TEAMS_REDIRECT_URI);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.deepEqual(url.searchParams.get('scope')?.split(' '), [...TEAMS_GRAPH_SCOPES]);
  assert.match(formatTeamsOAuthError('AADSTS65001: consent_required'), /administrator/i);
  assert.match(formatTeamsOAuthError('AADSTS50020 personal Microsoft account'), /work or school/i);

  console.log('teams-oauth-config: all tests passed');
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { run };
