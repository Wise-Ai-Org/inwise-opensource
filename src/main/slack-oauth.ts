/** One-click Slack OAuth for the local-first desktop application. */

import {
  constants,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
} from 'crypto';
import { classifySlackToken, validateToken } from './slack-client';

const DEFAULT_BROKER_URL = 'https://appwise-functions.azurewebsites.net/api/login-slack-code';
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

interface BrokerHandoff {
  algorithm: 'RSA-OAEP-256+A256GCM';
  encryptedKey: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

interface SlackHandoffPayload {
  token: string;
  teamId?: string;
  teamName?: string;
  userId?: string;
  scopes?: string[];
}

export interface SlackOAuthDeps {
  brokerUrl?: string;
  fetchFn?: typeof fetch;
  openExternal?: (url: string) => Promise<void>;
  delayFn?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  validateTokenFn?: typeof validateToken;
}

export interface SlackOAuthConnection {
  token: string;
  teamName?: string;
  userName?: string;
  tokenType: 'user';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openInBrowser(url: string): Promise<void> {
  const { shell } = require('electron') as typeof import('electron');
  await shell.openExternal(url);
}

function brokerUrl(deps: SlackOAuthDeps): string {
  return deps.brokerUrl
    || process.env.INWISE_SLACK_OAUTH_BROKER_URL
    || DEFAULT_BROKER_URL;
}

async function postBroker(
  body: Record<string, unknown>,
  deps: SlackOAuthDeps,
): Promise<{ response: Response; data: any }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const response = await fetchFn(brokerUrl(deps), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Slack OAuth service returned HTTP ${response.status}`);
  }
  if (!response.ok && response.status !== 202) {
    throw new Error(data?.error || `Slack OAuth service returned HTTP ${response.status}`);
  }
  return { response, data };
}

function assertSlackAuthorizeUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Slack OAuth service did not return an authorization URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'slack.com' || url.pathname !== '/oauth/v2/authorize') {
    throw new Error('Slack OAuth service returned an untrusted authorization URL');
  }
  return url.toString();
}

function decryptHandoff(handoff: BrokerHandoff, privateKey: string): SlackHandoffPayload {
  if (!handoff || handoff.algorithm !== 'RSA-OAEP-256+A256GCM') {
    throw new Error('Slack OAuth service returned an unsupported handoff');
  }
  try {
    const handoffKey = privateDecrypt({
      key: privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    }, Buffer.from(handoff.encryptedKey, 'base64'));
    const decipher = createDecipheriv(
      'aes-256-gcm',
      handoffKey,
      Buffer.from(handoff.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(handoff.authTag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(handoff.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')) as SlackHandoffPayload;
  } catch {
    throw new Error('Slack OAuth handoff could not be decrypted');
  }
}

/**
 * Open Slack consent in the system browser and claim the resulting xoxp token
 * from the hosted broker. The private handoff key exists only in this call.
 */
async function runSlackOAuth(deps: SlackOAuthDeps): Promise<SlackOAuthConnection> {
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const { data: start } = await postBroker({
    action: 'desktop-start',
    publicKey: keys.publicKey,
  }, deps);
  if (!start?.ok || typeof start.sessionId !== 'string' || typeof start.pollSecret !== 'string') {
    throw new Error(start?.error || 'Slack OAuth service could not start a session');
  }

  const authUrl = assertSlackAuthorizeUrl(start.authUrl);
  await (deps.openExternal ?? openInBrowser)(authUrl);

  const nowMs = deps.nowMs ?? Date.now;
  const wait = deps.delayFn ?? delay;
  const brokerLifetimeMs = Number(start.expiresInSeconds) * 1000;
  const timeoutMs = Math.min(
    Number.isFinite(brokerLifetimeMs) && brokerLifetimeMs > 0 ? brokerLifetimeMs : DEFAULT_TIMEOUT_MS,
    deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const deadline = nowMs() + timeoutMs;

  while (nowMs() < deadline) {
    await wait(deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const { data: result } = await postBroker({
      action: 'desktop-poll',
      sessionId: start.sessionId,
      pollSecret: start.pollSecret,
    }, deps);
    if (result?.status === 'pending') continue;
    if (result?.status === 'error') {
      throw new Error(result.error || 'Slack authorization failed');
    }
    if (result?.status !== 'complete') {
      throw new Error('Slack OAuth service returned an invalid session state');
    }

    const payload = decryptHandoff(result.handoff as BrokerHandoff, keys.privateKey);
    if (classifySlackToken(payload.token) !== 'user') {
      throw new Error('Slack OAuth did not return a channel-capable user token');
    }
    const validation = await (deps.validateTokenFn ?? validateToken)(payload.token);
    if (!validation.ok || validation.tokenType !== 'user') {
      throw new Error(validation.error || 'Slack rejected the OAuth token');
    }
    return {
      token: payload.token,
      teamName: validation.teamName || payload.teamName,
      userName: validation.userName || payload.userId,
      tokenType: 'user',
    };
  }

  throw new Error('Slack authorization timed out. Please try again.');
}

let activeConnection: Promise<SlackOAuthConnection> | null = null;

export function connectSlackWithOAuth(deps: SlackOAuthDeps = {}): Promise<SlackOAuthConnection> {
  if (activeConnection) return activeConnection;
  activeConnection = runSlackOAuth(deps).finally(() => {
    activeConnection = null;
  });
  return activeConnection;
}

export const SLACK_OAUTH_BROKER_URL = DEFAULT_BROKER_URL;
