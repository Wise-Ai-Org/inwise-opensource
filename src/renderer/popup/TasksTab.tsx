import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtDueDate, useNav } from './nav';

type Status = 'todo' | 'inProgress' | 'completed';

interface TaskRow {
  _id: string;
  title: string;
  status: Status | 'cancelled';
  priority?: string;
  owner?: string | null;
  dueDate: string | null;
  source?: { type: string; id?: string };
  aiExtracted?: boolean;
  approval?: { status: string };
  jiraKey?: string;
  jiraUrl?: string;
}

const STATUS_LABEL: Record<Status, string> = { todo: 'To Do', inProgress: 'In Progress', completed: 'Done' };

// ── Owner picker: me + tracked people + "Someone else…" free entry ──────────
// A typed name goes through addTrackedPeople, whose fuzzy matcher attaches it
// to an existing person when it can ("Bob" → "Robert Smith") — the canonical
// name comes back as the owner, so no duplicate people are minted.

export function OwnerPicker({ value, userName, people, onChange, onPersonAdded, style }: {
  value: string;
  userName: string;
  people: string[];
  onChange: (name: string) => void;
  onPersonAdded?: (name: string) => void;
  style?: React.CSSProperties;
}) {
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  const [resolving, setResolving] = useState(false);

  const confirmTyped = async () => {
    const name = typed.trim();
    if (!name) { setTyping(false); return; }
    setResolving(true);
    try {
      const results = await api().addTrackedPeople?.([name]).catch(() => null);
      const canonical = results?.[0]?.name || name;
      onChange(canonical);
      onPersonAdded?.(canonical);
    } finally {
      setResolving(false);
      setTyping(false);
      setTyped('');
    }
  };

  if (typing) {
    return (
      <span className="pp-search" style={{ padding: '4px 8px', maxWidth: 190 }}>
        <input
          autoFocus
          placeholder={resolving ? 'Adding…' : 'Type a name — Enter'}
          value={typed}
          disabled={resolving}
          onChange={e => setTyped(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') confirmTyped();
            if (e.key === 'Escape') { setTyping(false); setTyped(''); }
          }}
          onBlur={() => { if (typed.trim()) confirmTyped(); else setTyping(false); }}
        />
      </span>
    );
  }

  return (
    <select
      value={value}
      onChange={e => {
        if (e.target.value === '__other__') { setTyping(true); return; }
        onChange(e.target.value);
      }}
      style={style}
    >
      <option value="">Unassigned</option>
      {userName && <option value={userName}>{userName} (me)</option>}
      {people.filter(n => n !== userName).map(n => <option key={n} value={n}>{n}</option>)}
      {value && !people.includes(value) && value !== userName && <option value={value}>{value}</option>}
      <option value="__other__">Someone else…</option>
    </select>
  );
}

// ── Create-task sheet — deliberately not engineering-shaped ──────────────────
// Just: what, who's responsible, best if done by, priority, details.

function CreateTaskSheet({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [owner, setOwner] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [priority, setPriority] = useState('medium');
  const [people, setPeople] = useState<string[]>([]);
  const [userName, setUserName] = useState('');
  const [aiFilled, setAiFilled] = useState(false);
  const [saving, setSaving] = useState(false);
  const suggestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touched = useRef<{ owner: boolean; dueDate: boolean; priority: boolean }>({ owner: false, dueDate: false, priority: false });

  useEffect(() => {
    api().getPeople?.().then((rows: any[]) =>
      setPeople((rows || []).map(p => p.name).filter(Boolean))).catch(() => {});
    api().getConfig?.().then((c: any) => setUserName(c?.userName || '')).catch(() => {});
  }, []);

  // AI pre-fill: once the title says enough, fill only the fields the user
  // hasn't touched. Quiet — one note line, no banners.
  useEffect(() => {
    if (title.trim().length < 8) return;
    if (suggestTimer.current) clearTimeout(suggestTimer.current);
    suggestTimer.current = setTimeout(async () => {
      try {
        const res = await api().suggestTaskFields?.({ title: title.trim(), modalType: 'create' });
        if (!res) return;
        let applied = false;
        const val = (k: string) => res[k]?.value ?? res[k];
        if (!touched.current.priority && typeof val('priority') === 'string') { setPriority(val('priority')); applied = true; }
        if (!touched.current.dueDate && typeof val('dueDate') === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val('dueDate'))) {
          setDueDate(val('dueDate').slice(0, 10)); applied = true;
        }
        if (!touched.current.owner && typeof val('assignee') === 'string') { setOwner(val('assignee')); applied = true; }
        if (applied) setAiFilled(true);
      } catch { /* suggestions are optional */ }
    }, 700);
    return () => { if (suggestTimer.current) clearTimeout(suggestTimer.current); };
  }, [title]);

  const create = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      await api().createTask?.({
        title: title.trim(),
        description: description.trim() || undefined,
        owner: owner || undefined,
        dueDate: dueDate ? new Date(dueDate + 'T12:00:00').toISOString() : undefined,
        priority,
        status: 'todo',
      });
      onCreated();
    } finally {
      setSaving(false);
    }
  };

  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 2px' };
  const controlStyle: React.CSSProperties = { border: 'none', outline: 'none', fontSize: 12.5, fontWeight: 600, color: 'var(--teal)', background: 'transparent', fontFamily: 'inherit', textAlign: 'right', maxWidth: 170 };

  return (
    <>
      <div className="pp-sheet-backdrop" onClick={onClose} />
      <div className="pp-sheet" role="dialog" aria-label="New task">
        <div className="pp-sheet-handle" />
        <div className="pp-title-sm" style={{ fontSize: 15 }}>New task</div>
        <div className="pp-search">
          <input
            autoFocus
            placeholder="What needs to be done?"
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
          />
        </div>
        <div className="pp-listcard">
          <div style={rowStyle}>
            <span style={{ fontSize: 13, color: 'var(--navy)' }}>Who's responsible</span>
            <OwnerPicker
              value={owner}
              userName={userName}
              people={people}
              onChange={(name) => { touched.current.owner = true; setOwner(name); }}
              onPersonAdded={(name) => setPeople(p => (p.includes(name) ? p : [...p, name]))}
              style={controlStyle}
            />
          </div>
          <div style={{ ...rowStyle, borderTop: '1px solid var(--slate-100)' }}>
            <span style={{ fontSize: 13, color: 'var(--navy)' }}>Best if done by</span>
            <input type="date" value={dueDate} onChange={e => { touched.current.dueDate = true; setDueDate(e.target.value); }} style={controlStyle} />
          </div>
          <div style={{ ...rowStyle, borderTop: '1px solid var(--slate-100)' }}>
            <span style={{ fontSize: 13, color: 'var(--navy)' }}>Priority</span>
            <select value={priority} onChange={e => { touched.current.priority = true; setPriority(e.target.value); }} style={controlStyle}>
              {['low', 'medium', 'high', 'critical'].map(p => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
            </select>
          </div>
        </div>
        <div className="pp-search" style={{ alignItems: 'flex-start' }}>
          <textarea
            placeholder="Details (optional)"
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={2}
            style={{ flex: 1, border: 'none', outline: 'none', resize: 'none', fontSize: 12.5, fontFamily: 'inherit', color: 'var(--navy)', background: 'transparent' }}
          />
        </div>
        {aiFilled && <div className="pp-meta">Some fields were pre-filled from the title — change anything that's off.</div>}
        <div className="pp-row" style={{ gap: 8 }}>
          <button className="pp-btn pp-ghost" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
          <button className="pp-btn pp-solid" style={{ flex: 2 }} disabled={!title.trim() || saving} onClick={create}>
            {saving ? 'Creating…' : 'Create task'}
          </button>
        </div>
      </div>
    </>
  );
}

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
                  {t.owner && <span className="pp-chip">{t.owner}</span>}
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

      {createOpen && (
        <CreateTaskSheet
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); reload(); }}
        />
      )}
    </div>
  );
}
