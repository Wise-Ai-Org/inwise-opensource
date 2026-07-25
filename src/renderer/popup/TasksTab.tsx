import React, { useCallback, useEffect, useState } from 'react';
import { api, fmtDueDate, useNav } from './nav';
import CreateTaskModal from '../components/tasks/CreateTaskModal';

type Status = 'todo' | 'inProgress' | 'completed';

interface TaskRow {
  _id: string;
  title: string;
  status: Status | 'cancelled';
  priority?: string;
  dueDate: string | null;
  source?: { type: string; id?: string };
  aiExtracted?: boolean;
  approval?: { status: string };
  jiraKey?: string;
  jiraUrl?: string;
}

const STATUS_LABEL: Record<Status, string> = { todo: 'To Do', inProgress: 'In Progress', completed: 'Done' };

export default function TasksTab() {
  const { push } = useNav();
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [snoozed, setSnoozed] = useState<TaskRow[]>([]);
  const [seg, setSeg] = useState<Status>('todo');
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    const a = api();
    Promise.allSettled([a.getTasks?.(), a.getSnoozedTasks?.()]).then(([t, s]) => {
      setTasks(t.status === 'fulfilled' && Array.isArray(t.value) ? t.value : []);
      setSnoozed(s.status === 'fulfilled' && Array.isArray(s.value) ? s.value : []);
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    reload();
    const a = api();
    const onChanged = () => reload();
    a.on?.('tasks:reprioritized', onChanged);
    a.on?.('tasks:likely-done-updated', onChanged);
    a.on?.('jira:auto-synced', onChanged);
    return () => {
      a.off?.('tasks:reprioritized', onChanged);
      a.off?.('tasks:likely-done-updated', onChanged);
      a.off?.('jira:auto-synced', onChanged);
    };
  }, [reload]);

  const counts: Record<Status, number> = {
    todo: tasks.filter(t => t.status === 'todo').length,
    inProgress: tasks.filter(t => t.status === 'inProgress').length,
    completed: tasks.filter(t => t.status === 'completed').length,
  };

  const visible = tasks
    .filter(t => t.status === seg)
    .sort((a, b) => {
      const da = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
      const db = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
      return da - db;
    });

  const cycleStatus = async (t: TaskRow) => {
    const next: Status = t.status === 'todo' ? 'inProgress' : t.status === 'inProgress' ? 'completed' : 'todo';
    setTasks(rows => rows.map(r => (r._id === t._id ? { ...r, status: next } : r)));
    try { await api().updateTask?.(t._id, { status: next }); } catch { reload(); }
  };

  const bringBack = async (id: string) => {
    await api().bringBackTask?.(id);
    reload();
  };

  const bringBackAll = async () => {
    await api().bringBackAllTasks?.();
    setShowSnoozed(false);
    reload();
  };

  return (
    <div className="pp-body">
      {!showSnoozed && (
        <>
          <div className="pp-seg">
            {(['todo', 'inProgress', 'completed'] as Status[]).map(s => (
              <button key={s} className={seg === s ? 'pp-on' : ''} onClick={() => setSeg(s)}>
                {STATUS_LABEL[s]}<b>{counts[s]}</b>
              </button>
            ))}
          </div>

          <div className="pp-row" style={{ justifyContent: 'space-between', padding: '0 2px' }}>
            <button className="pp-link" onClick={() => push({ kind: 'review', focus: 'priorities' })}>Review priorities</button>
            <button className="pp-link" onClick={() => setCreateOpen(true)}>+ New task</button>
          </div>

          {loaded && visible.length === 0 && (
            <div className="pp-meta" style={{ textAlign: 'center', padding: '28px 0' }}>
              Nothing in {STATUS_LABEL[seg]}.
            </div>
          )}

          {visible.map(t => {
            const due = fmtDueDate(t.dueDate);
            return (
              <div
                key={t._id}
                className="pp-card pp-clickable"
                role="button"
                onClick={() => push({ kind: 'task', id: t._id })}
              >
                <div className="pp-title-sm">{t.title}</div>
                <div className="pp-row" style={{ marginTop: 7, flexWrap: 'wrap', gap: 6 }}>
                  {due && <span className={`pp-chip ${due.overdue ? 'pp-amber' : ''}`}>{due.label}</span>}
                  {t.source?.type === 'meeting' && <span className="pp-chip">From meeting</span>}
                  {t.jiraKey && <span className="pp-chip">Jira · {t.jiraKey}</span>}
                  {t.aiExtracted && t.approval?.status === 'pending' && <span className="pp-chip pp-amber">Awaiting approval</span>}
                  <span className="pp-grow" />
                  <button
                    className="pp-chip pp-teal"
                    title="Move to next status"
                    onClick={e => { e.stopPropagation(); cycleStatus(t); }}
                  >
                    {STATUS_LABEL[t.status as Status] || t.status} →
                  </button>
                </div>
              </div>
            );
          })}

          {snoozed.length > 0 && (
            <div className="pp-row" style={{ justifyContent: 'center' }}>
              <button className="pp-quiet-action" onClick={() => setShowSnoozed(true)}>
                Snoozed ({snoozed.length})
              </button>
            </div>
          )}
        </>
      )}

      {showSnoozed && (
        <>
          <div className="pp-row" style={{ justifyContent: 'space-between', padding: '0 2px' }}>
            <button className="pp-link" onClick={() => setShowSnoozed(false)}>← Board</button>
            <button className="pp-link" onClick={bringBackAll}>Bring back all</button>
          </div>
          {snoozed.length === 0 && (
            <div className="pp-meta" style={{ textAlign: 'center', padding: '28px 0' }}>No snoozed tasks.</div>
          )}
          {snoozed.map(t => (
            <div key={t._id} className="pp-card">
              <div className="pp-row">
                <div className="pp-grow">
                  <div className="pp-title-sm">{t.title}</div>
                  {(t as any).snoozeReason && <div className="pp-meta" style={{ marginTop: 2 }}>{(t as any).snoozeReason}</div>}
                </div>
                <button className="pp-link" onClick={() => bringBack(t._id)}>Bring back</button>
              </div>
            </div>
          ))}
        </>
      )}

      <CreateTaskModal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        onTaskCreated={() => { setCreateOpen(false); reload(); }}
      />
    </div>
  );
}
