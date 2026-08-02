import * as assert from 'node:assert/strict';
import {
  constants,
  createCipheriv,
  createPublicKey,
  publicEncrypt,
  randomBytes,
} from 'crypto';
import { connectSlackWithOAuth } from './slack-oauth';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function encryptHandoff(publicKey: string, payload: unknown): Record<string, string> {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload))),
    cipher.final(),
  ]);
  return {
    algorithm: 'RSA-OAEP-256+A256GCM',
    encryptedKey: publicEncrypt({
      key: createPublicKey(publicKey),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    }, key).toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

async function run(): Promise<void> {
  let publicKey = '';
  let polls = 0;
  const opened: string[] = [];
  const connection = await connectSlackWithOAuth({
    brokerUrl: 'https://broker.example/slack',
    delayFn: async () => {},
    openExternal: async (url) => { opened.push(url); },
    validateTokenFn: async (token) => {
      assert.equal(token, 'xoxp-oauth-user-token');
      return { ok: true, tokenType: 'user', teamName: 'Wise', userName: 'Shrav' };
    },
    fetchFn: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.action === 'desktop-start') {
        publicKey = body.publicKey;
        return jsonResponse({
          ok: true,
          sessionId: 'session-1',
          pollSecret: 'poll-secret',
          authUrl: 'https://slack.com/oauth/v2/authorize?client_id=123&state=abc',
          expiresInSeconds: 600,
        }, 201);
      }
      polls++;
      if (polls === 1) return jsonResponse({ ok: true, status: 'pending' }, 202);
      return jsonResponse({
        ok: true,
        status: 'complete',
        handoff: encryptHandoff(publicKey, {
          token: 'xoxp-oauth-user-token',
          teamName: 'Broker Team',
          userId: 'U123',
          scopes: ['channels:history'],
        }),
      });
    },
  });

  assert.equal(opened.length, 1);
  assert.match(opened[0], /^https:\/\/slack\.com\/oauth\/v2\/authorize/);
  assert.equal(polls, 2);
  assert.deepEqual(connection, {
    token: 'xoxp-oauth-user-token',
    teamName: 'Wise',
    userName: 'Shrav',
    tokenType: 'user',
  });

  await assert.rejects(
    () => connectSlackWithOAuth({
      brokerUrl: 'https://broker.example/slack',
      openExternal: async () => {},
      fetchFn: async () => jsonResponse({
        ok: true,
        sessionId: 'session-2',
        pollSecret: 'poll-secret',
        authUrl: 'https://evil.example/oauth',
        expiresInSeconds: 600,
      }, 201),
    }),
    /untrusted authorization URL/,
  );

  await assert.rejects(
    () => connectSlackWithOAuth({
      brokerUrl: 'https://broker.example/slack',
      delayFn: async () => {},
      openExternal: async () => {},
      fetchFn: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.action === 'desktop-start') {
          return jsonResponse({
            ok: true,
            sessionId: 'session-cancelled',
            pollSecret: 'poll-secret',
            authUrl: 'https://slack.com/oauth/v2/authorize?client_id=123&state=cancelled',
            expiresInSeconds: 600,
          }, 201);
        }
        return jsonResponse({
          ok: true,
          status: 'error',
          error: 'Slack authorization was cancelled',
        });
      },
    }),
    /Slack authorization was cancelled/,
  );

  console.log('slack-oauth: all tests passed');
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { run };
