import * as assert from 'node:assert/strict';
import Datastore from '@seald-io/nedb';
import {
  __setCredentialsDbForTests,
  getZoomCredentials,
  setZoomClientCredentials,
  setZoomTokens,
  clearZoomCredentials,
} from './database';

async function freshDb(): Promise<Datastore<any>> {
  const db = new Datastore<any>();
  await db.loadDatabaseAsync();
  return db;
}

async function run(): Promise<void> {
  // ── getZoomCredentials returns null when empty ────────────────────────────
  __setCredentialsDbForTests(await freshDb());
  const empty = await getZoomCredentials();
  assert.equal(empty, null, 'returns null when no credentials stored');

  // ── setZoomClientCredentials creates document ─────────────────────────────
  __setCredentialsDbForTests(await freshDb());
  await setZoomClientCredentials('client-id-123', 'client-secret-abc');
  const creds = await getZoomCredentials();
  assert.ok(creds !== null, 'credentials exist after set');
  assert.equal(creds!.zoomClientId, 'client-id-123', 'clientId stored');
  assert.equal(creds!.zoomClientSecret, 'client-secret-abc', 'clientSecret stored');
  assert.equal(creds!.zoomAccessToken, null, 'tokens null initially');
  assert.equal(creds!.zoomRefreshToken, null);
  assert.equal(creds!.zoomTokenExpiresAt, null);

  // ── setZoomClientCredentials upserts (overwrites existing) ───────────────
  await setZoomClientCredentials('client-id-NEW', 'client-secret-NEW');
  const updated = await getZoomCredentials();
  assert.equal(updated!.zoomClientId, 'client-id-NEW', 'clientId updated');
  assert.equal(updated!.zoomClientSecret, 'client-secret-NEW', 'clientSecret updated');

  // ── setZoomTokens merges tokens into existing doc ─────────────────────────
  await setZoomTokens({
    zoomAccessToken: 'access-token-xyz',
    zoomRefreshToken: 'refresh-token-xyz',
    zoomTokenExpiresAt: '2026-06-02T00:00:00.000Z',
  });
  const withTokens = await getZoomCredentials();
  assert.equal(withTokens!.zoomClientId, 'client-id-NEW', 'clientId preserved after setZoomTokens');
  assert.equal(withTokens!.zoomAccessToken, 'access-token-xyz', 'accessToken stored');
  assert.equal(withTokens!.zoomRefreshToken, 'refresh-token-xyz', 'refreshToken stored');
  assert.equal(withTokens!.zoomTokenExpiresAt, '2026-06-02T00:00:00.000Z', 'expiresAt stored');

  // ── setZoomTokens creates doc when none exists ────────────────────────────
  __setCredentialsDbForTests(await freshDb());
  await setZoomTokens({
    zoomAccessToken: 'tok',
    zoomRefreshToken: 'rtok',
    zoomTokenExpiresAt: '2026-07-01T00:00:00.000Z',
  });
  const tokOnly = await getZoomCredentials();
  assert.ok(tokOnly !== null, 'doc created by setZoomTokens alone');
  assert.equal(tokOnly!.zoomClientId, null, 'clientId null when not set before tokens');
  assert.equal(tokOnly!.zoomAccessToken, 'tok');

  // ── clearZoomCredentials removes the document ─────────────────────────────
  await clearZoomCredentials();
  const afterClear = await getZoomCredentials();
  assert.equal(afterClear, null, 'credentials removed after clear');

  console.log('zoom-credentials: all tests passed');
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { run };
