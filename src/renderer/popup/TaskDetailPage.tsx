import React, { useEffect, useState } from 'react';
import { api, useNav } from './nav';
import { OwnerPicker } from './TasksTab';
import { MentionThread, RepetitionNudge } from './DedupBits';

type Status = 'todo' | 'inProgress' | 'completed';
const STATUS_LABEL: Record<Status, string> = { todo: 'To Do', inProgress: 'In Progress', completed: 'Done' };
const PRIORITIES = ['low', 'medium', 'high', 'critical'];

function splitExecutionOutcome(summary?: string | null): { update: string; draft: string | null } {
  const text = summary?.trim() || '';
  const match = /\n\s*Full draft:\s*\n/i.exec(text);
  if (!match || match.index == null) return { update: text, draft: null };
  return {
    update: text.slice(0, match.index).trim(),
    draft: text.slice(match.index + match[0].length).trim() || null,
  };
}

function executionClientLabel(client?: string): string {
  if (!client) return 'AI client';
  if (client === 'claude-code') return 'Claude Code';
  if (client === 'openworker') return 'OpenWorker';
  if (client === 'codex') return 'Codex';
  return client.replace(/[-_]/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

function ExecutionCard({ summary }: { summary: any }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const outcome = splitExecutionOutcome(summary.latestOutcomeSummary);
  const hasOutcome = !!summary.latestOutcomeSummary;
  const hasExternalTools = (summary.proposedTools?.length || 0) > 0 || (summary.approvedTools?.length || 0) > 0;
  const awaitingReview = summary.status === 'running' && hasOutcome && !!summary.remainingWork;
  const state = summary.status === 'completed'
    ? { label: 'Completed', tone: 'teal', heading: 'Action completed' }
    : summary.status === 'failed'
      ? { label: 'Needs attention', tone: 'amber', heading: 'Execution needs attention' }
      : summary.status === 'cancelled'
        ? { label: 'Cancelled', tone: '', heading: 'Execution cancelled' }
        : awaitingReview
          ? { label: 'Awaiting review', tone: 'amber', heading: outcome.draft ? 'Draft ready for review' : 'Progress ready for review' }
          : { label: 'In progress', tone: '', heading: 'Approved plan in progress' };

  const copyDraft = async () => {
    if (!outcome.draft || !navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(outcome.draft);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="pp-exec-card">
      <div className="pp-exec-head">
        <div className="pp-exec-mark">AI</div>
        <div className="pp-grow">
          <div className="pp-exec-heading">{state.heading}</div>
          <div className="pp-meta">{executionClientLabel(summary.client)} · saved to Inwise</div>
        </div>
        <span className={`pp-chip ${state.tone === 'teal' ? 'pp-teal' : state.tone === 'amber' ? 'pp-amber' : ''}`}>
          {state.label}
        </span>
      </div>

      <div className="pp-exec-steps" aria-label="Execution progress">
        {[
          { label: 'Plan approved', done: true },
          { label: 'Outcome saved', done: hasOutcome },
          { label: 'Work complete', done: summary.status === 'completed' },
        ].map((step, index, steps) => (
          <React.Fragment key={step.label}>
            <div className={`pp-exec-step ${step.done ? 'pp-done' : ''}`}>
              <span className="pp-exec-dot">{step.done ? '✓' : ''}</span>
              <span>{step.label}</span>
            </div>
            {index < steps.length - 1 && (
              <span className={`pp-exec-line ${step.done && steps[index + 1].done ? 'pp-done' : ''}`} />
            )}
          </React.Fragment>
        ))}
      </div>

      <div className={`pp-exec-safety ${hasExternalTools ? 'pp-scope' : ''}`}>
        <span>✓</span>
        <span>{hasExternalTools ? 'External access stayed within the approved scope.' : 'Draft only · No external tools used · Nothing sent'}</span>
      </div>

      {outcome.update && <div className="pp-exec-update">{outcome.update}</div>}

      {outcome.draft && (
        <div className="pp-exec-draft">
          <div className="pp-exec-draft-head">
            <span>Email draft</span>
            <button onClick={copyDraft}>{copied ? 'Copied' : 'Copy draft'}</button>
          </div>
          <div className="pp-exec-draft-body">{outcome.draft}</div>
        </div>
      )}

      {(summary.artifacts?.length || 0) > 0 && (
        <div className="pp-exec-artifacts">
          {summary.artifacts.map((artifact: any, index: number) => (
            <button key={`${artifact.url}-${index}`} className="pp-link" onClick={() => api().openExternal?.(artifact.url)}>
              ↗ {artifact.label}
            </button>
          ))}
        </div>
      )}

      {summary.remainingWork && (
        <div className="pp-exec-next">
          <div>Next step</div>
          <span>{summary.remainingWork}</span>
        </div>
      )}

      <button className="pp-exec-toggle" onClick={() => setExpanded(value => !value)}>
        Execution details <span>{expanded ? '⌄' : '›'}</span>
      </button>

      {expanded && (
        <div className="pp-exec-details">
          <div>
            <label>Objective</label>
            <p>{summary.objective}</p>
          </div>
          {(summary.plan?.length || 0) > 0 && (
            <div>
              <label>Approved plan</label>
              <ol>{summary.plan.map((step: string, index: number) => <li key={index}>{step}</li>)}</ol>
            </div>
          )}
          <div>
            <label>Approval scope</label>
            <p>{summary.approvalScope || 'The connected AI client recorded the approved execution scope.'}</p>
            <small>{(summary.approvedTools?.length || 0) > 0 ? `Approved tools: ${summary.approvedTools.join(', ')}` : 'Approved tools: none'}</small>
          </div>
          {summary.lastStatusNote && (
            <div>
              <label>Status note</label>
              <p>{summary.lastStatusNote}</p>
            </div>
          )}
        </div>
      )}

      <div className="pp-exec-approved">Approved by {summary.approvedBy || 'the user'}</div>
    </div>
  );
}

export default function TaskDetailPage({ taskId }: { taskId: string }) {
  const { pop, push } = useNav();
  const [task, setTask] = useState<any>(null);
  const [loaded, setLoaded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const [people, setPeople] = useState<string[]>([]);
  const [userName, setUserName] = useState('');
  const [savedAt, setSavedAt] = useState(0);
  const [allTasks, setAllTasks] = useState<any[]>([]);
  const [mergePicking, setMergePicking] = useState(false);
  const [merging, setMerging] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    api().getTasks?.().then((rows: any[]) => {
      setAllTasks(rows || []);
      setTask((rows || []).find(t => t._id === taskId) || null);
    }).catch(() => {}).finally(() => setLoaded(true));
    api().getPeople?.().then((rows: any[]) =>
      setPeople((rows || []).map(p => p.name).filter(Boolean))).catch(() => {});
    api().getConfig?.().then((c: any) => setUserName(c?.userName || '')).catch(() => {});
  }, [taskId, reloadKey]);

  // Show a transient confirmation after every silent auto-save — edits here
  // persist immediately and the user should see that.
  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(0), 1800);
    return () => clearTimeout(t);
  }, [savedAt]);

  const patch = async (updates: Record<string, any>) => {
    setTask((t: any) => (t ? { ...t, ...updates } : t));
    try {
      await api().updateTask?.(taskId, updates);
      setSavedAt(Date.now());
    } catch { /* refetch on next open */ }
  };

  const doDelete = async () => {
    await api().deleteTask?.(taskId);
    pop();
  };

  const doSnooze = async (reason: string) => {
    await api().snoozeTask?.(taskId, reason);
    pop();
  };

  // Manual merge (US-010): this task absorbs the other one's mentions; the
  // other is archived, never deleted, so nothing is lost.
  const doMerge = async (loserId: string) => {
    setMerging(true);
    try {
      await api().dedupMergeTasks?.(taskId, loserId);
      setMergePicking(false);
      setReloadKey(k => k + 1);
    } finally {
      setMerging(false);
    }
  };

  const dueValue = task?.dueDate ? new Date(task.dueDate) : null;
  const dueInput = dueValue && !Number.isNaN(dueValue.getTime())
    ? `${dueValue.getFullYear()}-${String(dueValue.getMonth() + 1).padStart(2, '0')}-${String(dueValue.getDate()).padStart(2, '0')}`
    : '';

  return (
    <>
      <div className="pp-drillhead">
        <button className="pp-back" aria-label="Back" onClick={pop}>←</button>
        <div className="pp-drilltitle">Task</div>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--teal)', textAlign: 'right' }}>
          {savedAt ? '✓ Saved' : ''}
        </span>
      </div>
      <div className="pp-body" style={{ paddingTop: 4 }}>
        {!loaded && <div className="pp-meta" style={{ textAlign: 'center', padding: 20 }}>Loading…</div>}
        {loaded && !task && <div className="pp-meta" style={{ textAlign: 'center', padding: 20 }}>Task not found.</div>}
        {task && (
          <>
            <div className="pp-card">
              <div className="pp-title-sm" style={{ fontSize: 15 }}>{task.title}</div>
              {task.description && (
                <div style={{ fontSize: 12.5, color: 'var(--slate-700)', lineHeight: 1.5, marginTop: 6 }}>{task.description}</div>
              )}
              <div className="pp-row" style={{ marginTop: 8, gap: 6, flexWrap: 'wrap' }}>
                {task.jiraKey && <span className="pp-chip">Jira · {task.jiraKey}</span>}
                {task.aiExtracted && <span className="pp-chip pp-teal">Wiser caught this</span>}
                {task.likelyDone && <span className="pp-chip pp-amber">Looks done — confirm?</span>}
              </div>
              {task.repetitionNudge?.show && (
                <div className="pp-row" style={{ marginTop: 8 }}>
                  <RepetitionNudge
                    taskId={taskId}
                    count={task.repetitionNudge.count}
                    onChanged={() => setReloadKey(k => k + 1)}
                  />
                </div>
              )}
            </div>

            <MentionThread taskId={taskId} onChanged={() => setReloadKey(k => k + 1)} />

            {task.executionSummary && (
              <>
                <div className="pp-seclabel">AI execution</div>
                <ExecutionCard summary={task.executionSummary} />
              </>
            )}

            {task.likelyDone && (
              <div className="pp-row" style={{ gap: 8 }}>
                <button className="pp-btn pp-solid" style={{ flex: 1, padding: '7px 0' }} onClick={async () => {
                  await api().confirmLikelyDone?.(taskId);
                  patch({ status: 'completed', likelyDone: false });
                }}>Yes, it's done</button>
                <button className="pp-btn pp-ghost" style={{ flex: 1, padding: '7px 0' }} onClick={async () => {
                  await api().rejectLikelyDone?.(taskId);
                  patch({ likelyDone: false });
                }}>Still open</button>
              </div>
            )}

            <div className="pp-seclabel">Status</div>
            <div className="pp-card" style={{ padding: '10px 12px' }}>
              <div className="pp-seg">
                {(['todo', 'inProgress', 'completed'] as Status[]).map(s => (
                  <button key={s} className={task.status === s ? 'pp-on' : ''} onClick={() => patch({ status: s })}>
                    {STATUS_LABEL[s]}
                  </button>
                ))}
              </div>
            </div>

            <div className="pp-seclabel">Details — changes save automatically</div>
            <div className="pp-listcard">
              <div className="pp-setrow" style={{ cursor: 'default' }}>
                <div className="pp-grow pp-rowlabel" style={{ fontWeight: 500 }}>Who's responsible</div>
                <OwnerPicker
                  value={task.owner || ''}
                  userName={userName}
                  people={people}
                  onChange={(name) => patch({ owner: name || null })}
                  onPersonAdded={(name) => setPeople(p => (p.includes(name) ? p : [...p, name]))}
                  style={{ border: 'none', outline: 'none', fontSize: 12.5, fontWeight: 600, color: 'var(--teal)', background: 'transparent', fontFamily: 'inherit', maxWidth: 160 }}
                />
              </div>
              <div className="pp-setrow" style={{ cursor: 'default' }}>
                <div className="pp-grow pp-rowlabel" style={{ fontWeight: 500 }}>Due date</div>
                <input
                  type="date"
                  value={dueInput}
                  onChange={e => patch({ dueDate: e.target.value ? new Date(e.target.value + 'T12:00:00').toISOString() : null })}
                  style={{ border: 'none', outline: 'none', fontSize: 12.5, fontWeight: 600, color: 'var(--teal)', background: 'transparent', fontFamily: 'inherit' }}
                />
              </div>
              <div className="pp-setrow" style={{ cursor: 'default' }}>
                <div className="pp-grow pp-rowlabel" style={{ fontWeight: 500 }}>Priority</div>
                <select
                  value={task.priority || 'medium'}
                  onChange={e => patch({ priority: e.target.value })}
                  style={{ border: 'none', outline: 'none', fontSize: 12.5, fontWeight: 600, color: 'var(--teal)', background: 'transparent', fontFamily: 'inherit' }}
                >
                  {PRIORITIES.map(p => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
                </select>
              </div>
            </div>

            {task.priorityReasoning && (
              <div className="pp-card" style={{ background: 'var(--pp-teal-tint)', borderColor: 'var(--pp-teal-line)', padding: '10px 12px' }}>
                <div style={{ fontSize: 12, color: 'var(--pp-teal-deep)', lineHeight: 1.45 }}>{task.priorityReasoning}</div>
              </div>
            )}

            {task.source?.type === 'meeting' && task.source?.id && (
              <>
                <div className="pp-seclabel">Source</div>
                <button
                  className="pp-card pp-clickable"
                  style={{ textAlign: 'left', width: '100%', fontFamily: 'inherit' }}
                  onClick={() => push({ kind: 'meeting', id: task.source.id })}
                >
                  <div className="pp-row">
                    <div className="pp-grow pp-title-sm">Open source meeting</div>
                    <span className="pp-chevron">›</span>
                  </div>
                </button>
              </>
            )}

            {mergePicking && (
              <>
                <div className="pp-seclabel">Which task is the same as this one?</div>
                <div className="pp-listcard">
                  {allTasks.filter(t => t._id !== taskId).slice(0, 30).map((t, i) => (
                    <button
                      key={t._id}
                      className="pp-setrow"
                      style={{ width: '100%', textAlign: 'left', fontFamily: 'inherit', background: 'transparent', border: 'none', borderTop: i === 0 ? 'none' : '1px solid var(--slate-100)' }}
                      disabled={merging}
                      onClick={() => doMerge(t._id)}
                    >
                      <div className="pp-grow pp-rowlabel" style={{ fontWeight: 500 }}>{t.title}</div>
                      <span className="pp-chevron">›</span>
                    </button>
                  ))}
                </div>
                <div className="pp-meta" style={{ padding: '0 4px' }}>
                  Its mentions move onto this task. The other card is archived, not deleted.
                </div>
              </>
            )}

            <div className="pp-row" style={{ justifyContent: 'flex-start', padding: '4px 4px 0' }}>
              <button className="pp-quiet-action" onClick={() => setMergePicking(v => !v)}>
                {mergePicking ? 'Cancel merge' : 'Same as another task…'}
              </button>
            </div>

            <div className="pp-row" style={{ justifyContent: 'space-between', padding: '4px 4px 0' }}>
              {snoozing ? (
                <span className="pp-row" style={{ gap: 8 }}>
                  <button className="pp-quiet-action" onClick={() => doSnooze('Snoozed for a week')}>1 week</button>
                  <button className="pp-quiet-action" onClick={() => doSnooze('Snoozed until next month')}>1 month</button>
                  <button className="pp-quiet-action" onClick={() => setSnoozing(false)}>Cancel</button>
                </span>
              ) : (
                <button className="pp-quiet-action" onClick={() => setSnoozing(true)}>Snooze until…</button>
              )}
              {confirmDelete ? (
                <span className="pp-row" style={{ gap: 8 }}>
                  <button className="pp-quiet-action" style={{ color: 'var(--red)' }} onClick={doDelete}>Confirm delete</button>
                  <button className="pp-quiet-action" onClick={() => setConfirmDelete(false)}>Cancel</button>
                </span>
              ) : (
                <button className="pp-quiet-action" style={{ color: 'var(--red)' }} onClick={() => setConfirmDelete(true)}>Delete task</button>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
