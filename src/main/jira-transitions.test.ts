import * as assert from 'node:assert/strict';
import { pickTransition, targetCategory, statusLabel, noTransitionMessage, localStatusForCategory } from './jira-transitions';

const T = (id: string, name: string, to: string, cat?: string) => ({ id, name, to: { name: to, statusCategory: cat ? { key: cat } : undefined } });

function run(): void {
  assert.equal(targetCategory('completed'), 'done');
  assert.equal(targetCategory('done'), 'done');
  assert.equal(targetCategory('inProgress'), 'indeterminate');
  assert.equal(targetCategory('in_progress'), 'indeterminate');
  assert.equal(targetCategory('In Progress'), 'indeterminate');
  assert.equal(targetCategory('todo'), 'new');
  assert.equal(targetCategory('Ready for QA'), null);
  assert.equal(statusLabel('completed'), 'Done');
  assert.equal(statusLabel('inProgress'), 'In Progress');
  assert.equal(statusLabel('Ready for QA'), 'Ready for QA');

  // Category beats a misleading transition name ("Ship it" goes to a done-category status).
  {
    const list = [T('11', 'Start work', 'Doing', 'indeterminate'), T('31', 'Ship it', 'Shipped', 'done')];
    assert.equal(pickTransition(list, 'completed')?.id, '31');
    assert.equal(pickTransition(list, 'inProgress')?.id, '11');
    assert.equal(pickTransition(list, 'todo'), null);
  }

  // Exact destination name first.
  {
    const list = [T('1', 'Resolve', 'Resolved', 'done'), T('2', 'Close', 'Closed', 'done')];
    assert.equal(pickTransition(list, 'Closed')?.id, '2');
    // Two done-category transitions: prefer one whose name reads as done.
    assert.ok(['1', '2'].includes(pickTransition(list, 'done')!.id));
  }

  // Payloads without statusCategory fall back to names.
  {
    const list = [{ id: '5', name: 'Done' }, { id: '6', name: 'In Progress' }];
    assert.equal(pickTransition(list, 'completed')?.id, '5');
    assert.equal(pickTransition(list, 'inProgress')?.id, '6');
  }

  // Custom workflow status asked by name with no match.
  assert.equal(pickTransition([T('1', 'Start', 'Doing', 'indeterminate')], 'Ready for QA'), null);
  assert.equal(pickTransition([], 'done'), null);
  assert.equal(noTransitionMessage('PILOT-42', 'completed'), 'PILOT-42 has no transition to Done');

  assert.equal(localStatusForCategory('done'), 'completed');
  assert.equal(localStatusForCategory('indeterminate'), 'inProgress');
  assert.equal(localStatusForCategory('new'), 'todo');
  assert.equal(localStatusForCategory(undefined), null);

  console.log('jira-transitions: all tests passed');
}

run();
