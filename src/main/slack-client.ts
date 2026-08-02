/**
 * Local Slack Web API client. All calls run from the Electron main process.
 *
 * Public/private channel threads require a user OAuth token. Slack does not
 * allow bot tokens to call conversations.replies for those channel types, so
 * the supported connection path is an xoxp user token with the documented
 * read/write scopes.
 */

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

export interface SlackMessage {
  ts: string;
  user: string;
  text: string;
  threadTs?: string;
  replyCount?: number;
  latestReply?: string;
}

export interface SlackUser {
  id: string;
  name: string;
  displayName: string;
  realName: string;
}

export type SlackTokenType = 'user' | 'bot' | 'unknown';

export interface SlackApiDeps {
  token?: string;
  fetchFn?: typeof fetch;
  delayFn?: (ms: number) => Promise<void>;
}

export interface SlackConnectionInfo {
  connected: boolean;
  tokenType: SlackTokenType | 'none';
  threadCapable: boolean;
}

const SLACK_BASE = 'https://slack.com/api';
const MAX_RETRIES = 5;
// Slack caps non-Marketplace conversations.history/replies calls at 15 items.
const CONVERSATIONS_PAGE_SIZE = '15';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Keep the HTTP client usable in plain Node tests. Electron-backed config and
// logging are loaded only when a production call actually needs them.
function appLog(level: 'info' | 'warn' | 'error', message: string, detail?: string): void {
  try {
    (require('./logger') as typeof import('./logger')).log(level, message, detail);
  } catch {
    // Logging must never make a Slack operation fail (including unit tests).
  }
}

export function classifySlackToken(token: string): SlackTokenType {
  if (token.startsWith('xoxp-')) return 'user';
  if (token.startsWith('xoxb-')) return 'bot';
  return 'unknown';
}

function configuredToken(): string | undefined {
  const { getConfig } = require('./config') as typeof import('./config');
  const config = getConfig() as any;
  // slackBotToken is retained as a read fallback for existing installations.
  return (config.slackUserToken || config.slackBotToken) as string | undefined;
}

function resolveToken(deps: SlackApiDeps): string {
  const token = deps.token || configuredToken();
  if (!token) throw new Error('Slack user OAuth token not configured');
  return token;
}

function apiError(data: any, endpoint: string): Error {
  const needed = data?.needed ? `; needs scope ${data.needed}` : '';
  return new Error(`Slack API error: ${data?.error || 'unknown_error'} (${endpoint}${needed})`);
}

async function slackGet(
  endpoint: string,
  params: Record<string, string> = {},
  deps: SlackApiDeps = {},
): Promise<any> {
  const token = resolveToken(deps);
  const fetchFn = deps.fetchFn ?? fetch;
  const wait = deps.delayFn ?? delay;
  const qs = new URLSearchParams(params).toString();
  const url = `${SLACK_BASE}/${endpoint}${qs ? `?${qs}` : ''}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetchFn(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10);
      appLog('warn', 'slack:rate-limited', `GET ${endpoint} — retry after ${retryAfter}s`);
      await wait(retryAfter * 1000);
      continue;
    }

    if (!res.ok) throw new Error(`Slack HTTP ${res.status} on ${endpoint}`);

    const data = (await res.json()) as any;
    if (!data.ok) throw apiError(data, endpoint);
    return data;
  }

  throw new Error(`Slack: max retries exceeded for ${endpoint}`);
}

async function slackPost(
  endpoint: string,
  body: Record<string, unknown>,
  deps: SlackApiDeps = {},
): Promise<any> {
  const token = resolveToken(deps);
  const fetchFn = deps.fetchFn ?? fetch;
  const wait = deps.delayFn ?? delay;
  const url = `${SLACK_BASE}/${endpoint}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10);
      appLog('warn', 'slack:rate-limited', `POST ${endpoint} — retry after ${retryAfter}s`);
      await wait(retryAfter * 1000);
      continue;
    }

    if (!res.ok) throw new Error(`Slack HTTP ${res.status} on ${endpoint}`);

    const data = (await res.json()) as any;
    if (!data.ok) throw apiError(data, endpoint);
    return data;
  }

  throw new Error(`Slack: max retries exceeded for ${endpoint}`);
}

function mapMessage(message: any): SlackMessage {
  return {
    ts: message.ts as string,
    user: (message.user as string) ?? '',
    text: (message.text as string) ?? '',
    threadTs: message.thread_ts as string | undefined,
    replyCount: message.reply_count as number | undefined,
    latestReply: message.latest_reply as string | undefined,
  };
}

function sortAndDedupeMessages(messages: SlackMessage[]): SlackMessage[] {
  const byTs = new Map<string, SlackMessage>();
  for (const message of messages) byTs.set(message.ts, message);
  return [...byTs.values()].sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
}

export async function listChannels(deps: SlackApiDeps = {}): Promise<SlackChannel[]> {
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;

  do {
    const params: Record<string, string> = {
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: '200',
    };
    if (cursor) params.cursor = cursor;

    const data = await slackGet('conversations.list', params, deps);
    for (const channel of data.channels ?? []) {
      channels.push({
        id: channel.id as string,
        name: channel.name as string,
        isPrivate: (channel.is_private as boolean) ?? false,
        isMember: (channel.is_member as boolean) ?? false,
      });
    }
    cursor = (data.response_metadata?.next_cursor as string) || undefined;
  } while (cursor);

  return channels;
}

/** Fetch every history page after the persisted timestamp cursor. */
export async function getChannelHistory(
  channelId: string,
  sinceCursor?: string,
  deps: SlackApiDeps = {},
): Promise<{ messages: SlackMessage[] }> {
  const messages: SlackMessage[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const params: Record<string, string> = {
      channel: channelId,
      limit: CONVERSATIONS_PAGE_SIZE,
    };
    if (sinceCursor) params.oldest = sinceCursor;
    if (cursor) params.cursor = cursor;

    const data = await slackGet('conversations.history', params, deps);
    messages.push(...(data.messages ?? []).map(mapMessage));

    const next = (data.response_metadata?.next_cursor as string) || undefined;
    if (next && seenCursors.has(next)) {
      throw new Error('Slack returned a repeated conversations.history cursor');
    }
    if (next) seenCursors.add(next);
    cursor = next;
  } while (cursor);

  return { messages: sortAndDedupeMessages(messages) };
}

/** Fetch every page in a channel thread. Public/private channels need xoxp. */
export async function getThreadReplies(
  channelId: string,
  ts: string,
  deps: SlackApiDeps = {},
): Promise<SlackMessage[]> {
  const token = resolveToken(deps);
  if (classifySlackToken(token) !== 'user') {
    throw new Error('Slack channel threads require a User OAuth Token (xoxp-…), not a bot token');
  }

  const replies: SlackMessage[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const params: Record<string, string> = {
      channel: channelId,
      ts,
      limit: CONVERSATIONS_PAGE_SIZE,
    };
    if (cursor) params.cursor = cursor;

    const data = await slackGet('conversations.replies', params, deps);
    replies.push(...(data.messages ?? []).map(mapMessage));

    const next = (data.response_metadata?.next_cursor as string) || undefined;
    if (next && seenCursors.has(next)) {
      throw new Error('Slack returned a repeated conversations.replies cursor');
    }
    if (next) seenCursors.add(next);
    cursor = next;
  } while (cursor);

  return sortAndDedupeMessages(replies);
}

export async function postMessage(
  channelId: string,
  text: string,
  deps: SlackApiDeps = {},
): Promise<void> {
  await slackPost('chat.postMessage', { channel: channelId, text }, deps);
  appLog('info', 'slack:message-posted', `channel ${channelId}`);
}

const userCache = new Map<string, SlackUser>();

export async function resolveUser(
  userId: string,
  deps: SlackApiDeps = {},
): Promise<SlackUser | null> {
  if (userCache.has(userId)) return userCache.get(userId)!;

  try {
    const data = await slackGet('users.info', { user: userId }, deps);
    const raw = data.user;
    const user: SlackUser = {
      id: raw.id as string,
      name: (raw.name as string) ?? '',
      displayName: (raw.profile?.display_name as string) ?? '',
      realName: ((raw.profile?.real_name ?? raw.real_name) as string) ?? '',
    };
    userCache.set(userId, user);
    return user;
  } catch (error: any) {
    appLog('warn', 'slack:resolve-user-failed', `${userId}: ${error.message}`);
    return null;
  }
}

export async function validateToken(
  token: string,
  deps: Omit<SlackApiDeps, 'token'> = {},
): Promise<{
  ok: boolean;
  teamName?: string;
  userName?: string;
  tokenType: SlackTokenType;
  error?: string;
}> {
  const tokenType = classifySlackToken(token);
  if (tokenType === 'bot') {
    return {
      ok: false,
      tokenType,
      error: 'Bot tokens cannot read public/private channel threads. Use a User OAuth Token beginning xoxp-.',
    };
  }
  if (tokenType !== 'user') {
    return { ok: false, tokenType, error: 'Unsupported Slack token. Use a User OAuth Token beginning xoxp-.' };
  }

  try {
    const data = await slackPost('auth.test', {}, { ...deps, token });
    return {
      ok: true,
      teamName: data.team as string,
      userName: data.user as string,
      tokenType,
    };
  } catch (error: any) {
    return { ok: false, tokenType, error: error.message };
  }
}

export function getSlackConnectionInfo(): SlackConnectionInfo {
  const token = configuredToken();
  if (!token) return { connected: false, tokenType: 'none', threadCapable: false };
  const tokenType = classifySlackToken(token);
  return { connected: true, tokenType, threadCapable: tokenType === 'user' };
}

export function isSlackConnected(): boolean {
  return getSlackConnectionInfo().connected;
}

export interface PostWiserNoteDeps extends SlackApiDeps {
  writeChannels?: string[];
}

/** Post an explicitly user-requested Wiser note to an allowed write channel. */
export async function postWiserNote(
  channelId: string,
  note: string,
  deps: PostWiserNoteDeps = {},
): Promise<void> {
  const writeChannels = deps.writeChannels ?? (() => {
    const { getConfig } = require('./config') as typeof import('./config');
    return ((getConfig() as any).slackWriteChannels ?? []) as string[];
  })();

  if (!writeChannels.includes(channelId)) {
    throw new Error(`Channel ${channelId} is not in the Slack write-channels list`);
  }

  const trimmed = note.trim();
  if (!trimmed) throw new Error('Slack note cannot be empty');

  await postMessage(channelId, `*Wiser Note*\n${trimmed}`, deps);
  appLog('info', 'slack:wiser-note', `Posted to channel ${channelId}`);
}
