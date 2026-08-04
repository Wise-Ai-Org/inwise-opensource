import * as assert from 'node:assert/strict';
import Datastore from '@seald-io/nedb';
import {
  __setCredentialsDbForTests,
  clearOAuthCredentials,
  getOAuthCredentials,
  setOAuthClientCredentials,
  setOAuthTokens,
} from './database';

async function freshDb(): Promise<Datastore<any>> {
  const db = new Datastore<any>();
  await db.loadDatabaseAsync();
  return db;
}

async function run(): Promise<void> {
  __setCredentialsDbForTests(await freshDb());
  assert.equal(await getOAuthCredentials('teams'), null);

  await setOAuthClientCredentials('teams', { clientId: 'teams-client', tenant: 'tenant-id' });
  await setOAuthClientCredentials('meet', { clientId: 'google-client', clientSecret: 'google-secret' });
  await setOAuthTokens('teams', {
    accessToken: 'teams-access',
    refreshToken: 'teams-refresh',
    tokenExpiresAt: '2026-08-03T00:00:00.000Z',
  });

  const teams = await getOAuthCredentials('teams');
  const meet = await getOAuthCredentials('meet');
  assert.equal(teams?.clientId, 'teams-client');
  assert.equal(teams?.tenant, 'tenant-id');
  assert.equal(teams?.accessToken, 'teams-access');
  assert.equal(meet?.clientId, 'google-client');
  assert.equal(meet?.clientSecret, 'google-secret');
  assert.equal(meet?.accessToken, null, 'providers are isolated');

  await setOAuthClientCredentials('teams', { clientId: 'replacement-client', tenant: 'tenant-id' });
  const replaced = await getOAuthCredentials('teams');
  assert.equal(replaced?.accessToken, null, 'changing the OAuth client invalidates old tokens');
  assert.equal(replaced?.refreshToken, null);

  await clearOAuthCredentials('teams');
  assert.equal(await getOAuthCredentials('teams'), null);
  assert.ok(await getOAuthCredentials('meet'), 'clearing one provider preserves the other');

  console.log('oauth-credentials: all tests passed');
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { run };
