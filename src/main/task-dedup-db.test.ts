import * as assert from 'node:assert/strict';
import Datastore from '@seald-io/nedb';
import {
  __setTasksDbForTests,
  __setMeetingsDbForTests,
  saveInsights,
  createTask,
  getTasks,
  appendTaskMention,
  mergeTasksManual,
  undoSplitMention,
  resolvePendingDedup,
  bumpTaskPriority,
  dismissTaskNudge,
  syncCalendarEventsToDb,
} from './database';
import { __setMatchDecisionsDbForTests, listMatchDecisions, getMatchDecisionStats } from './match-decision-log';
import { __setLlmForTests, TaskMention } from './task-dedup';

const DAY = 24 * 60 * 60 * 1000;

function llm(results: Array<{ index: number; verdict: string; confidence: number }>): void {
  __setLlmForTests(async () => JSON.stringify({ results }));
}

async function freshDbs(): Promise<{ tasks: Datastore; meetings: Datastore; decisions: Datastore }> {
  const tasks = new Datastore<any>();
  const meetings = new Datastore<any>();
  const decisions = new Datastore<any>();
  await Promise.all([tasks.loadDatabaseAsync(), meetings.loadDatabaseAsync(), decisions.loadDatabaseAsync()]);
  __setTasksDbForTests(tasks);
  __setMeetingsDbForTests(meetings);
  __setMatchDecisionsDbForTests(decisions);
  return { tasks, meetings, decisions };
}

const EMPTY_INSIGHTS = { summary: '', actionItems: [] as any[], decisions: [] as any[], blockers: [] as any[] };

async function run(): Promise<void> {
  // ── US-013 + US-005: the meeting pipeline merges instead of duplicating ──
  {
    const { tasks, meetings } = await freshDbs();
    await meetings.insertAsync({ _id: 'm1', title: 'Vendor sync', date: new Date(Date.now() - 3 * DAY).toISOString(), attendees: ['Alex Chen'] });
    await meetings.insertAsync({ _id: 'm2', title: 'Weekly sync', date: new Date().toISOString(), attendees: ['Alex Chen'] });

    llm([]); // first meeting: no candidates exist, classifier is never reached
    await saveInsights('m1', { ...EMPTY_INSIGHTS, actionItems: [{ text: 'Chase legal on the MSA redline' }] });
    let all = await tasks.findAsync({});
    assert.equal(all.length, 1, 'first mention creates the task');
    const first: any = all[0];
    assert.equal(first.taskMentions.length, 1, 'new tasks initialize taskMentions with their originating mention');
    assert.equal(first.taskMentions[0].sourceType, 'meeting');
    assert.equal(first.taskMentions[0].sourceId, 'm1');
    assert.equal(first.mentionCount, 1);

    llm([{ index: 0, verdict: 'same_task', confidence: 94 }]);
    await saveInsights('m2', {
      ...EMPTY_INSIGHTS,
      actionItems: [{ text: 'Still blocked on legal, third time the MSA redline has come up' }],
    });
    all = await tasks.findAsync({});
    assert.equal(all.length, 1, 'a 94-confidence repeat merges — no second card');
    const merged: any = all[0];
    assert.equal(merged._id, first._id);
    assert.equal(merged.taskMentions.length, 2, 'the repeat lands as a second mention');
    assert.equal(merged.mentionCount, 2);
    assert.ok(merged.taskMentions[1].mergedItem, 'auto-merged mentions carry a snapshot so they can be split back out');
    assert.ok(merged.lastMentionedAt, 'lastMentionedAt is bumped');

    const logged = await listMatchDecisions();
    assert.equal(logged.length, 1);
    assert.equal(logged[0].decisionType, 'auto_merge');
    assert.equal(logged[0].decidedBy, 'system');
    assert.equal(logged[0].surface, 'oss');
    assert.equal(logged[0].confidence, 94);
    assert.equal(logged[0].candidateTaskId, first._id);
    assert.ok(logged[0].promptVersion, 'decisions record which prompt version judged them');
  }

  // ── US-007: an ask-band match rides on the pending task, not a new record ──
  {
    const { tasks, meetings } = await freshDbs();
    await meetings.insertAsync({ _id: 'm1', title: 'Vendor sync', date: new Date(Date.now() - 3 * DAY).toISOString(), attendees: [] });
    await meetings.insertAsync({ _id: 'm2', title: 'Weekly sync', date: new Date().toISOString(), attendees: [] });

    llm([]);
    await saveInsights('m1', { ...EMPTY_INSIGHTS, actionItems: [{ text: 'Chase legal on the MSA redline' }] });
    const original: any = (await tasks.findAsync({}))[0];

    llm([{ index: 0, verdict: 'same_task', confidence: 72 }]);
    await saveInsights('m2', {
      ...EMPTY_INSIGHTS,
      actionItems: [{ text: 'Still blocked on legal, third time the MSA redline has come up' }],
    });

    const pending: any = (await tasks.findAsync({})).find((t: any) => t._id !== original._id);
    assert.ok(pending, 'ask-band still creates the pending task so nothing is lost');
    assert.ok(pending.dedupSuggestion, 'the classifier result rides along on the pending task');
    assert.equal(pending.dedupSuggestion.candidateTaskId, original._id);
    assert.equal(pending.dedupSuggestion.confidence, 72);
    assert.equal(pending.dedupSuggestion.wasDone, false);
    assert.ok(pending.dedupSuggestion.model, 'the confirm card gets a model label for the transparency line');
    assert.equal((await listMatchDecisions()).length, 0, 'nothing is logged until the user answers');

    // User says "same task"
    const res = await resolvePendingDedup(pending._id, 'same');
    assert.deepEqual(res, { ok: true, mergedInto: original._id });
    assert.equal((await tasks.findAsync({})).length, 1, 'the pending duplicate is gone after the merge');
    const survivor: any = await tasks.findOneAsync({ _id: original._id });
    assert.equal(survivor.taskMentions.length, 2);
    const decisions = await listMatchDecisions();
    assert.equal(decisions[0].decisionType, 'confirm_same');
    assert.equal(decisions[0].decidedBy, 'user');
  }

  // "New task" keeps it standalone and logs the negative example
  {
    const { tasks, meetings } = await freshDbs();
    await meetings.insertAsync({ _id: 'm1', title: 'A', date: new Date(Date.now() - 3 * DAY).toISOString(), attendees: [] });
    await meetings.insertAsync({ _id: 'm2', title: 'B', date: new Date().toISOString(), attendees: [] });
    llm([]);
    await saveInsights('m1', { ...EMPTY_INSIGHTS, actionItems: [{ text: 'Chase legal on the MSA redline' }] });
    const original: any = (await tasks.findAsync({}))[0];
    llm([{ index: 0, verdict: 'same_task', confidence: 65 }]);
    await saveInsights('m2', { ...EMPTY_INSIGHTS, actionItems: [{ text: 'Still blocked on legal, third time the MSA redline has come up' }] });
    const pending: any = (await tasks.findAsync({})).find((t: any) => t._id !== original._id);

    await resolvePendingDedup(pending._id, 'new');
    assert.equal((await tasks.findAsync({})).length, 2, 'both tasks survive');
    const kept: any = await tasks.findOneAsync({ _id: pending._id });
    assert.equal(kept.dedupSuggestion, undefined, 'the answered question is cleared off the card');
    const decisions = await listMatchDecisions();
    assert.equal(decisions[0].decisionType, 'confirm_new');
  }

  // ── US-008: "Reopen and merge" is the only path back from done ───────────
  {
    const { tasks, meetings } = await freshDbs();
    await meetings.insertAsync({ _id: 'm1', title: 'A', date: new Date(Date.now() - 3 * DAY).toISOString(), attendees: [] });
    await meetings.insertAsync({ _id: 'm2', title: 'B', date: new Date().toISOString(), attendees: [] });
    llm([]);
    await saveInsights('m1', { ...EMPTY_INSIGHTS, actionItems: [{ text: 'Chase legal on the MSA redline' }] });
    const original: any = (await tasks.findAsync({}))[0];
    await tasks.updateAsync({ _id: original._id }, { $set: { status: 'done', updatedAt: new Date().toISOString() } }, {});

    llm([{ index: 0, verdict: 'same_task', confidence: 95 }]);
    await saveInsights('m2', { ...EMPTY_INSIGHTS, actionItems: [{ text: 'Still blocked on legal, third time the MSA redline has come up' }] });

    const pending: any = (await tasks.findAsync({})).find((t: any) => t._id !== original._id);
    assert.ok(pending?.dedupSuggestion, '95 against a done task asks rather than auto-merging');
    assert.equal(pending.dedupSuggestion.wasDone, true, 'the prompt is the reopen variant');
    const stillDone: any = await tasks.findOneAsync({ _id: original._id });
    assert.equal(stillDone.status, 'done', 'nothing reopened without the user saying so');

    await resolvePendingDedup(pending._id, 'reopen');
    const reopened: any = await tasks.findOneAsync({ _id: original._id });
    assert.equal(reopened.status, 'todo', 'reopen-and-merge is one action');
    assert.equal(reopened.taskMentions.length, 2);
    const decisions = await listMatchDecisions();
    assert.equal(decisions[0].decisionType, 'reopen_merge');
  }

  // ── US-010 + US-011: manual merge → undo/split, and the log aggregates ───
  {
    const { tasks, decisions: decisionsDb } = await freshDbs();
    const a: any = await createTask({ title: 'Chase legal on the MSA redline' });
    const b: any = await createTask({ title: 'MSA redline still with legal' });

    await mergeTasksManual(a._id, b._id);
    const survivor: any = await tasks.findOneAsync({ _id: a._id });
    const loser: any = await tasks.findOneAsync({ _id: b._id });
    assert.equal(survivor.taskMentions.length, 1, "the loser's mention moves onto the survivor");
    assert.ok(survivor.taskMentions[0].mergedItem, 'absorbed mentions carry a snapshot');
    assert.equal(survivor.taskMentions[0].mergedItem.title, 'MSA redline still with legal');
    assert.ok(loser.archivedAt, 'the losing task is archived');
    assert.equal(loser.mergedInto, a._id, 'and points at its survivor');
    assert.equal(await tasks.countAsync({ _id: b._id }), 1, 'archived, never deleted');

    const mentionId = survivor.taskMentions[0].id;
    const split: any = await undoSplitMention(a._id, mentionId);
    assert.ok(split, 'undo/split recreates a standalone task');
    assert.equal(split.title, 'MSA redline still with legal', 'rebuilt from the mergedItem snapshot');
    assert.equal(split.taskMentions.length, 1, 'the split-out task carries its own mention');
    const afterSplit: any = await tasks.findOneAsync({ _id: a._id });
    assert.equal(afterSplit.taskMentions.length, 0, 'the mention left the survivor');

    const seq = (await listMatchDecisions()).map((d: any) => d.decisionType);
    assert.deepEqual(seq, ['undo_split', 'manual_merge'], 'both actions are logged, newest first');
    const loggedRows: any[] = await decisionsDb.findAsync({});
    assert.equal(loggedRows.length, 2);
    assert.equal(new Set(loggedRows.map(row => row.sequence)).size, 2, 'same-millisecond decisions retain insertion order');

    // Aggregates the PRD asks for
    await decisionsDb.insertAsync({ decisionType: 'auto_merge', createdAt: new Date().toISOString(), surface: 'oss' });
    await decisionsDb.insertAsync({ decisionType: 'auto_merge', createdAt: new Date().toISOString(), surface: 'oss' });
    await decisionsDb.insertAsync({ decisionType: 'confirm_same', createdAt: new Date().toISOString(), surface: 'oss' });
    await decisionsDb.insertAsync({ decisionType: 'confirm_new', createdAt: new Date().toISOString(), surface: 'oss' });
    const stats = await getMatchDecisionStats();
    assert.equal(stats.counts.auto_merge, 2);
    assert.equal(stats.counts.undo_split, 1);
    assert.equal(stats.counts.manual_merge, 1);
    assert.equal(stats.total, 6);
    assert.equal(stats.falseMergeRate, 0.5, 'false-merge rate = undone ÷ auto-merges');
    assert.equal(stats.confirmRate, 0.5, 'confirm rate = same ÷ prompts answered');
  }

  // ── Pre-feature tasks: the originating mention is synthesized on merge ───
  {
    await freshDbs();
    const legacy: any = await createTask({ title: 'Chase legal on the MSA redline' });
    // Simulate a row written before taskMentions existed
    await appendTaskMention(legacy._id, {
      id: 'new-mention', sourceType: 'meeting', sourceId: 'm9', sourceTitle: 'Weekly sync',
      excerpt: 'legal again', occurredAt: new Date().toISOString(),
    } as TaskMention);
    const updated = (await getTasks()).find((t: any) => t._id === legacy._id) as any;
    assert.equal(updated.mentionCount, 1, 'a manual task has no meeting origin to synthesize');

    // Idempotency: re-processing the same meeting does not double-append
    await appendTaskMention(legacy._id, {
      id: 'new-mention-2', sourceType: 'meeting', sourceId: 'm9', sourceTitle: 'Weekly sync',
      excerpt: 'legal again', occurredAt: new Date().toISOString(),
    } as TaskMention);
    const again = (await getTasks()).find((t: any) => t._id === legacy._id) as any;
    assert.equal(again.mentionCount, 1, 're-processing a meeting does not duplicate its mention');
  }

  // ── US-014: nudge annotation, explicit bump, dismissal ──────────────────
  {
    await freshDbs();
    const t: any = await createTask({ title: 'Chase legal on the MSA redline', priority: 'medium' });
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await appendTaskMention(t._id, {
        id: `m${i}`, sourceType: 'meeting', sourceId: `src${i}`, excerpt: `mention ${i}`,
        occurredAt: new Date(now - i * DAY).toISOString(),
      } as TaskMention);
    }

    let row = (await getTasks()).find((x: any) => x._id === t._id) as any;
    assert.equal(row.repetitionNudge.show, true, 'getTasks annotates the card with the nudge');
    assert.equal(row.repetitionNudge.count, 3);
    assert.equal(row.priority, 'medium', 'priority has not moved on its own');

    const bumped: any = await bumpTaskPriority(t._id);
    assert.equal(bumped.priority, 'high', 'the tap moves priority exactly one step');

    await dismissTaskNudge(t._id);
    row = (await getTasks()).find((x: any) => x._id === t._id) as any;
    assert.equal(row.repetitionNudge.show, false, 'dismissal hides the chip');

    await appendTaskMention(t._id, {
      id: 'm4', sourceType: 'voice_note', sourceId: 'v1', excerpt: 'again', occurredAt: new Date().toISOString(),
    } as TaskMention);
    row = (await getTasks()).find((x: any) => x._id === t._id) as any;
    assert.equal(row.repetitionNudge.show, true, 'the chip returns once it comes up again');
  }

  // ── OQ4: calendar sync persists the bare series uid ─────────────────────
  {
    const { meetings } = await freshDbs();
    const past = new Date(Date.now() - DAY);
    await syncCalendarEventsToDb([{
      id: 'series-abc_1750000000000',
      title: 'Weekly sync',
      startTime: past,
      endTime: new Date(past.getTime() + 3600_000),
      attendees: ['Alex Chen'],
      seriesUid: 'series-abc',
    }]);
    const row: any = await meetings.findOneAsync({ calendarEventId: 'series-abc_1750000000000' });
    assert.equal(row.seriesUid, 'series-abc', 'the series uid is stored as its own field at sync time');
  }

  __setLlmForTests(null);
  console.log('task-dedup-db: all tests passed');
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { run };
