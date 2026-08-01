/** Pure batching and inactivity helpers for Slack polling. */

import type { SlackMessage } from './slack-client';

export interface SlackHistoryPartition {
  threadParents: SlackMessage[];
  looseMessages: SlackMessage[];
}

export function partitionSlackHistory(messages: SlackMessage[]): SlackHistoryPartition {
  const threadParents: SlackMessage[] = [];
  const looseMessages: SlackMessage[] = [];

  for (const message of messages) {
    const isTopLevel = !message.threadTs || message.threadTs === message.ts;
    if (!isTopLevel) continue;
    if ((message.replyCount ?? 0) > 0) threadParents.push(message);
    else looseMessages.push(message);
  }

  return { threadParents, looseMessages };
}

export function latestSlackActivityTs(messages: SlackMessage[], fallbackTs: string): string {
  return messages.reduce(
    (latest, message) => parseFloat(message.ts) > parseFloat(latest) ? message.ts : latest,
    fallbackTs,
  );
}

export function isSlackThreadQuiet(
  latestActivityTs: string,
  inactivityWindowMin: number,
  nowMs: number = Date.now(),
): boolean {
  const latestMs = Math.floor(parseFloat(latestActivityTs) * 1000);
  return Number.isFinite(latestMs)
    && nowMs - latestMs >= inactivityWindowMin * 60 * 1000;
}
