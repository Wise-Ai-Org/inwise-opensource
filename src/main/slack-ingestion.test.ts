import * as assert from 'node:assert/strict';
import { isSlackThreadQuiet, latestSlackActivityTs, partitionSlackHistory } from './slack-ingestion';
import type { SlackMessage } from './slack-client';

function run(): void {
  const messages: SlackMessage[] = [
    { ts: '1.0', user: 'U1', text: 'loose' },
    { ts: '2.0', user: 'U1', text: 'parent', replyCount: 2, latestReply: '4.0' },
    { ts: '3.0', user: 'U2', text: 'reply', threadTs: '2.0' },
  ];
  const partition = partitionSlackHistory(messages);
  assert.deepEqual(partition.looseMessages.map((message) => message.ts), ['1.0']);
  assert.deepEqual(partition.threadParents.map((message) => message.ts), ['2.0']);

  assert.equal(latestSlackActivityTs(messages, '0.0'), '3.0');
  assert.equal(isSlackThreadQuiet('100.0', 1, 159_999), false);
  assert.equal(isSlackThreadQuiet('100.0', 1, 160_000), true);

  console.log('slack-ingestion: all tests passed');
}

if (require.main === module) run();

export { run };
