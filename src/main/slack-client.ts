/**
 * Local Slack API client — all calls run from the Electron main process.
 * Auth is a plain bot token stored in electron-store (no OAuth).
 */

import { getConfig } from './config';
import { log } from './logger';

// ── Types ──────────────────────────────────────────────────────────────────

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

// ── Internal fetch helper ──────────────────────────────────────────────────

const SLACK_BASE = 'https://slack.com/api';
const MAX_RETRIES = 5;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getToken(): string {
  const config = getConfig();
  const token = (config as any).slackBotToken as string | undefined;
  if (!token) throw new Error('Slack bot token not configured');
  return token;
}

async function slackGet(
  endpoint: string,
  params: Record<string, string> = {},
): Promise<any> {
  const token = getToken();
  const qs = new URLSearchParams(params).toString();
  const url = `${SLACK_BASE}/${endpoint}${qs ? `?${qs}` : ''}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '5', 10);
      log('warn', 'slack:rate-limited', `GET ${endpoint} — retry after ${retryAfter}s`);
      await delay(retryAfter * 1000);
      continue;
    }

    if (!res.ok) throw new Error(`Slack HTTP ${res.status} on ${endpoint}`);

    const data = (await res.json()) as any;
    if (!data.ok) throw new Error(`Slack API error: ${data.error} (${endpoint})`);
    return data;
  }

  throw new Error(`Slack: max retries exceeded for ${endpoint}`);
}

async function slackPost(endpoint: string, body: Record<string, unknown>): Promise<any> {
  const token = getToken();
  const url = `${SLACK_BASE}/${endpoint}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '5', 10);
      log('warn', 'slack:rate-limited', `POST ${endpoint} — retry after ${retryAfter}s`);
      await delay(retryAfter * 1000);
      continue;
    }

    if (!res.ok) throw new Error(`Slack HTTP ${res.status} on ${endpoint}`);

    const data = (await res.json()) as any;
    if (!data.ok) throw new Error(`Slack API error: ${data.error} (${endpoint})`);
    return data;
  }

  throw new Error(`Slack: max retries exceeded for ${endpoint}`);
}

// ── listChannels ───────────────────────────────────────────────────────────

export async function listChannels(): Promise<SlackChannel[]> {
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;

  do {
    const params: Record<string, string> = {
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: '200',
    };
    if (cursor) params.cursor = cursor;

    const data = await slackGet('conversations.list', params);
    for (const ch of data.channels ?? []) {
      channels.push({
        id: ch.id as string,
        name: ch.name as string,
        isPrivate: (ch.is_private as boolean) ?? false,
        isMember: (ch.is_member as boolean) ?? false,
      });
    }
    cursor = (data.response_metadata?.next_cursor as string) || undefined;
  } while (cursor);

  return channels;
}

// ── getChannelHistory ──────────────────────────────────────────────────────

export async function getChannelHistory(
  channelId: string,
  sinceCursor?: string,
): Promise<{ messages: SlackMessage[]; nextCursor?: string }> {
  const params: Record<string, string> = {
    channel: channelId,
    limit: '200',
  };
  if (sinceCursor) params.oldest = sinceCursor;

  const data = await slackGet('conversations.history', params);

  const messages: SlackMessage[] = (data.messages ?? []).map((m: any) => ({
    ts: m.ts as string,
    user: (m.user as string) ?? '',
    text: (m.text as string) ?? '',
    threadTs: m.thread_ts as string | undefined,
    replyCount: m.reply_count as number | undefined,
    latestReply: m.latest_reply as string | undefined,
  }));

  const nextCursor = (data.response_metadata?.next_cursor as string) || undefined;
  return { messages, nextCursor };
}

// ── getThreadReplies ───────────────────────────────────────────────────────

export async function getThreadReplies(
  channelId: string,
  ts: string,
): Promise<SlackMessage[]> {
  const replies: SlackMessage[] = [];
  let cursor: string | undefined;

  do {
    const params: Record<string, string> = {
      channel: channelId,
      ts,
      limit: '200',
    };
    if (cursor) params.cursor = cursor;

    const data = await slackGet('conversations.replies', params);
    for (const m of data.messages ?? []) {
      replies.push({
        ts: m.ts as string,
        user: (m.user as string) ?? '',
        text: (m.text as string) ?? '',
        threadTs: m.thread_ts as string | undefined,
      });
    }
    cursor = (data.response_metadata?.next_cursor as string) || undefined;
  } while (cursor);

  return replies;
}

// ── postMessage ────────────────────────────────────────────────────────────

export async function postMessage(channelId: string, text: string): Promise<void> {
  await slackPost('chat.postMessage', { channel: channelId, text });
  log('info', 'slack:message-posted', `channel ${channelId}`);
}

// ── User resolution ────────────────────────────────────────────────────────

const userCache = new Map<string, SlackUser>();

export async function resolveUser(userId: string): Promise<SlackUser | null> {
  if (userCache.has(userId)) return userCache.get(userId)!;

  try {
    const data = await slackGet('users.info', { user: userId });
    const u = data.user;
    const user: SlackUser = {
      id: u.id as string,
      name: (u.name as string) ?? '',
      displayName: (u.profile?.display_name as string) ?? '',
      realName: ((u.profile?.real_name ?? u.real_name) as string) ?? '',
    };
    userCache.set(userId, user);
    return user;
  } catch (err: any) {
    log('warn', 'slack:resolve-user-failed', `${userId}: ${err.message}`);
    return null;
  }
}

// ── Token validation ───────────────────────────────────────────────────────

export async function validateToken(
  token: string,
): Promise<{ ok: boolean; teamName?: string; botName?: string; error?: string }> {
  try {
    const res = await fetch(`${SLACK_BASE}/auth.test`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({}),
    });
    const data = (await res.json()) as any;
    if (!data.ok) return { ok: false, error: data.error as string };
    return { ok: true, teamName: data.team as string, botName: data.user as string };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export function isSlackConnected(): boolean {
  const config = getConfig();
  return !!(config as any).slackBotToken;
}
