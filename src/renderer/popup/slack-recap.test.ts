import * as assert from 'node:assert/strict';
import { buildMeetingSlackRecap } from './slack-recap';

function run(): void {
  const recap = buildMeetingSlackRecap({
    title: 'Launch review',
    insights: {
      summary: 'The launch remains on schedule.',
      decisions: [{ text: 'Ship on Friday.' }],
      actionItems: [{ text: 'Publish release notes.', owner: 'Alex' }],
      blockers: [{ text: 'Waiting on legal.' }],
    },
  });

  assert.match(recap, /Launch review/);
  assert.match(recap, /\*Decisions\*/);
  assert.match(recap, /Publish release notes\. — Alex/);
  assert.match(recap, /Waiting on legal/);
  assert.doesNotMatch(recap, /transcript/i);

  console.log('slack-recap: all tests passed');
}

if (require.main === module) run();

export { run };
