/**
 * Normalize a Slack thread (parent + replies) into the local conversation
 * format consumed by the existing task pipeline.
 */

import { SlackMessage, SlackUser, resolveUser } from './slack-client';
import { log } from './logger';

export interface SlackThreadMeta {
  channelId: string;
  channelName: string;
  permalink: string;
}

export interface NormalizedConversation {
  /** Meeting title derived from the first message */
  title: string;
  /** ISO date string from the thread's parent timestamp */
  date: string;
  /** Resolved participant names */
  attendees: string[];
  /** Formatted transcript for the AI extraction pipeline */
  transcript: string;
  /** Slack-specific metadata */
  slackMeta: SlackThreadMeta;
}

// Build a Slack permalink given base workspace URL isn't available without an
// extra API call. We store channel + ts to reconstruct it if needed; for now
// the permalink field carries a deep-link style identifier.
function buildPermalink(channelId: string, ts: string): string {
  return `slack://channel?id=${channelId}&message=${ts}`;
}

function tsToDate(ts: string): Date {
  const epochSec = parseFloat(ts);
  return new Date(epochSec * 1000);
}

function formatLine(userName: string, text: string, ts: string): string {
  const time = tsToDate(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `[${time}] ${userName}: ${text}`;
}

/**
 * Normalize a Slack thread into a local conversation object.
 * @param messages - Full thread: first element is the parent, rest are replies
 * @param meta - Channel info
 */
export async function normalizeSlackThread(
  messages: SlackMessage[],
  meta: SlackThreadMeta,
): Promise<NormalizedConversation | null> {
  if (messages.length === 0) {
    log('warn', 'slack:normalizer', 'Empty thread — skipping');
    return null;
  }

  const parent = messages[0];
  const threadDate = tsToDate(parent.ts);

  // Resolve all unique user IDs to names
  const userIds = [...new Set(messages.map(m => m.user).filter(Boolean))];
  const userMap = new Map<string, string>();
  await Promise.all(
    userIds.map(async (uid) => {
      const user: SlackUser | null = await resolveUser(uid);
      const displayName = user?.displayName || user?.realName || user?.name || uid;
      userMap.set(uid, displayName);
    }),
  );

  const resolveName = (uid: string) => userMap.get(uid) ?? uid;

  // Format transcript lines
  const lines = messages.map(m =>
    formatLine(resolveName(m.user), m.text || '', m.ts),
  );
  const transcript = lines.join('\n');

  // Title: first ~80 chars of the parent message text
  const rawTitle = (parent.text || '').replace(/\n/g, ' ').trim();
  const title = rawTitle.length > 80
    ? rawTitle.slice(0, 77) + '…'
    : rawTitle || `Slack thread in #${meta.channelName}`;

  const attendees = userIds.map(resolveName);

  return {
    title,
    date: threadDate.toISOString(),
    attendees,
    transcript,
    slackMeta: {
      channelId: meta.channelId,
      channelName: meta.channelName,
      permalink: buildPermalink(meta.channelId, parent.ts),
    },
  };
}
