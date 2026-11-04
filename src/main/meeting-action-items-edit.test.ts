import * as assert from 'node:assert/strict';
import Datastore from '@seald-io/nedb';
import { __setTasksDbForTests, __setMeetingsDbForTests, updateMeetingActionItems, renameInMeeting } from './database';

async function run() {
  const meetings = new Datastore({ inMemoryOnly: true });
  const tasks = new Datastore({ inMemoryOnly: true });
  __setMeetingsDbForTests(meetings);
  __setTasksDbForTests(tasks);

  await tasks.insertAsync({ _id: 't1', title: 'Fix creator onboarding flow', owner: 'Satya', assignee: 'Satya', status: 'todo', approval: { status: 'pending' } });
  await tasks.insertAsync({ _id: 't2', title: 'Put up posters', owner: 'Shravani', assignee: 'Shravani', status: 'todo', approval: { status: 'pending' } });
  await tasks.insertAsync({ _id: 't3', title: 'Linked to Jira', status: 'todo', jiraKey: 'WX-1', approval: { status: 'pending' } });
  await meetings.insertAsync({
    _id: 'm1',
    transcript: 'Satya: I will fix the onboarding flow. Satyam: ok.',
    insights: {
      summary: 'Satya owns onboarding fixes.',
      actionItems: [
        { text: 'Fix creator onboarding flow', owner: 'Satya', taskId: 't1' },
        { text: 'Put up posters', owner: 'Shravani', taskId: 't2', isCommitment: true },
        { text: 'Linked to Jira', owner: null, taskId: 't3' },
      ],
      decisions: [{ text: 'Satya reviews the flow before launch' }],
    },
  });

  // Edit text and owner, check one off, delete two.
  const updated = await updateMeetingActionItems('m1', [
    { text: 'Fix creator onboarding', owner: 'Sacha', taskId: 't1' },
  ]);
  assert.equal(updated.insights.actionItems.length, 1);
  assert.equal(updated.insights.actionItems[0].owner, 'Sacha');
  const t1 = await tasks.findOneAsync({ _id: 't1' });
  assert.equal(t1.title, 'Fix creator onboarding');
  assert.equal(t1.owner, 'Sacha');
  assert.equal(t1.assignee, 'Sacha');
  assert.equal(await tasks.findOneAsync({ _id: 't2' }), null, 'deleted pending item removes its task');
  assert.ok(await tasks.findOneAsync({ _id: 't3' }), 'deleted item linked to Jira keeps its task');

  await updateMeetingActionItems('m1', [{ text: 'Fix creator onboarding', owner: 'Sacha', taskId: 't1', done: true }]);
  assert.equal((await tasks.findOneAsync({ _id: 't1' })).status, 'done');
  await updateMeetingActionItems('m1', [{ text: 'Fix creator onboarding', owner: 'Sacha', taskId: 't1', done: false }]);
  assert.equal((await tasks.findOneAsync({ _id: 't1' })).status, 'todo');

  // Empty text is dropped rather than saved.
  const trimmed = await updateMeetingActionItems('m1', [
    { text: 'Fix creator onboarding', owner: 'Sacha', taskId: 't1' },
    { text: '   ', owner: null },
  ]);
  assert.equal(trimmed.insights.actionItems.length, 1);

  // Rename everywhere: transcript, summary, decisions; whole words only.
  const renamed = await renameInMeeting('m1', 'Satya', 'Sacha');
  assert.equal(renamed.transcript, 'Sacha: I will fix the onboarding flow. Satyam: ok.');
  assert.equal(renamed.insights.summary, 'Sacha owns onboarding fixes.');
  assert.equal(renamed.insights.decisions[0].text, 'Sacha reviews the flow before launch');
  assert.equal(renamed.insights.actionItems[0].taskId, 't1');

  assert.equal(await updateMeetingActionItems('missing', []), null);
  console.log('meeting-action-items-edit: all tests passed');
}

run().catch((error) => { console.error(error); process.exit(1); });
