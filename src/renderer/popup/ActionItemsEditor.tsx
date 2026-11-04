import React, { useEffect, useRef, useState } from 'react';
import { api } from './nav';

export interface ActionItem {
  text: string;
  owner?: string | null;
  assignee?: string | null;
  isCommitment?: boolean;
  done?: boolean;
  taskId?: string | null;
  [key: string]: any;
}

interface Props {
  meetingId: string;
  items: ActionItem[];
  /** Names to offer in the owner picker (meeting invitees, resolved to people where known). */
  inviteeNames: string[];
  onMeetingUpdated: (meeting: any) => void;
}

const ownerOf = (item: ActionItem) => (item.owner || item.assignee || '').trim();
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export default function ActionItemsEditor({ meetingId, items: savedItems, inviteeNames, onMeetingUpdated }: Props) {
  const [items, setItems] = useState<ActionItem[]>(savedItems);
  const [editingText, setEditingText] = useState<number | null>(null);
  const [draftText, setDraftText] = useState('');
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const [typedName, setTypedName] = useState('');
  const [renameAsk, setRenameAsk] = useState<{ from: string; to: string } | null>(null);
  const [askedPairs] = useState(() => new Set<string>());
  const [undo, setUndo] = useState<{ item: ActionItem; index: number } | null>(null);
  const [error, setError] = useState('');
  const undoTimer = useRef<number | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  // Close the owner picker on a click outside it.
  useEffect(() => {
    if (pickerFor === null) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerFor(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pickerFor]);

  useEffect(() => { setItems(savedItems); }, [savedItems]);
  useEffect(() => () => { if (undoTimer.current) window.clearTimeout(undoTimer.current); }, []);

  const save = async (next: ActionItem[]) => {
    setItems(next);
    setError('');
    try {
      const updated = await api().updateMeetingActionItems?.(meetingId, next);
      if (updated) onMeetingUpdated(updated);
    } catch {
      setError('Could not save that change. Try again.');
      setItems(savedItems);
    }
  };

  const patch = (index: number, changes: Partial<ActionItem>) =>
    save(items.map((item, i) => (i === index ? { ...item, ...changes } : item)));

  const commitText = (index: number) => {
    const text = draftText.trim();
    setEditingText(null);
    if (text && text !== items[index].text) patch(index, { text });
  };

  const chooseOwner = (index: number, name: string) => {
    const to = name.trim();
    setPickerFor(null);
    setTypedName('');
    if (!to) return;
    const from = ownerOf(items[index]);
    if (from && sameName(from, to)) return;
    patch(index, { owner: to, assignee: to });
    // A name that is not on the invite list was probably misheard: offer to fix it everywhere, once.
    const key = `${from.toLowerCase()}>${to.toLowerCase()}`;
    const fromIsInvitee = inviteeNames.some((n) => sameName(n, from));
    if (from && !fromIsInvitee && !askedPairs.has(key)) {
      askedPairs.add(key);
      setRenameAsk({ from, to });
    }
  };

  const renameEverywhere = async () => {
    if (!renameAsk) return;
    const { from, to } = renameAsk;
    setRenameAsk(null);
    try {
      const updated = await api().renameInMeeting?.(meetingId, from, to, true);
      if (updated) onMeetingUpdated(updated);
    } catch {
      setError(`Could not change ${from} to ${to} everywhere.`);
    }
  };

  const remove = (index: number) => {
    const item = items[index];
    save(items.filter((_, i) => i !== index));
    setUndo({ item, index });
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndo(null), 6000);
  };

  const restore = () => {
    if (!undo) return;
    const next = [...items];
    next.splice(Math.min(undo.index, next.length), 0, undo.item);
    setUndo(null);
    save(next);
  };

  const ownerChoices = (() => {
    const names: string[] = [];
    for (const n of [...inviteeNames, ...items.map(ownerOf)]) {
      if (n && !names.some((existing) => sameName(existing, n))) names.push(n);
    }
    return names;
  })();

  return (
    <>
      <div className="pp-seclabel">Action items</div>

      {renameAsk && (
        <div className="pp-card" role="status" style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 13, color: 'var(--navy)', lineHeight: 1.4 }}>
            Change {renameAsk.from} to {renameAsk.to} everywhere in this meeting?
          </div>
          <div className="pp-meta" style={{ marginTop: 4 }}>
            Updates the summary, every item and the transcript. Future meetings will also use {renameAsk.to}.
          </div>
          <div className="pp-row" style={{ gap: 12, marginTop: 8 }}>
            <button className="pp-quiet-action" style={{ color: 'var(--teal)', fontWeight: 600 }} onClick={renameEverywhere}>Yes, everywhere</button>
            <button className="pp-quiet-action" onClick={() => setRenameAsk(null)}>Just this item</button>
          </div>
        </div>
      )}

      {items.length === 0 && <div className="pp-meta" style={{ padding: '4px 2px 10px' }}>No action items.</div>}

      {items.length > 0 && (
        <div className="pp-listcard">
          {items.map((item, i) => {
            const owner = ownerOf(item);
            return (
              <div key={item.taskId || `${i}-${item.text}`} className="pp-setrow" style={{ cursor: 'default', alignItems: 'flex-start', gap: 10, minHeight: 0 }}>
                <input
                  type="checkbox"
                  aria-label={item.done ? 'Mark not done' : 'Mark done'}
                  checked={!!item.done}
                  onChange={() => patch(i, { done: !item.done })}
                  style={{ marginTop: 3, accentColor: 'var(--teal)', cursor: 'pointer' }}
                />
                <div className="pp-grow" style={{ minWidth: 0 }}>
                  {editingText === i ? (
                    <textarea
                      autoFocus
                      aria-label="Action item text"
                      value={draftText}
                      rows={Math.min(4, Math.max(1, Math.ceil(draftText.length / 42)))}
                      onChange={(e) => setDraftText(e.target.value)}
                      onBlur={() => commitText(i)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(i); }
                        if (e.key === 'Escape') setEditingText(null);
                      }}
                      style={{ width: '100%', fontSize: 13, lineHeight: 1.4, color: 'var(--navy)', font: 'inherit', resize: 'none', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 6px' }}
                    />
                  ) : (
                    <div
                      role="button"
                      tabIndex={0}
                      title="Click to edit"
                      onClick={() => { setEditingText(i); setDraftText(item.text); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { setEditingText(i); setDraftText(item.text); } }}
                      style={{
                        fontSize: 13, lineHeight: 1.4, cursor: 'text',
                        color: item.done ? 'var(--slate-500, #8a94a6)' : 'var(--navy)',
                        textDecoration: item.done ? 'line-through' : 'none',
                      }}
                    >
                      {item.text}
                    </div>
                  )}

                  <div ref={pickerFor === i ? pickerRef : undefined} className="pp-row" style={{ gap: 6, marginTop: 5, flexWrap: 'wrap', position: 'relative' }}>
                    <button
                      aria-label={owner ? `Owner: ${owner}. Change owner` : 'Add owner'}
                      onClick={() => { setPickerFor(pickerFor === i ? null : i); setTypedName(''); }}
                      style={{
                        fontSize: 11.5, lineHeight: 1, padding: '4px 8px', borderRadius: 999, cursor: 'pointer',
                        border: '1px solid var(--line)', background: owner ? 'var(--surface-status, #eef6f6)' : 'transparent',
                        color: owner ? 'var(--navy)' : 'var(--slate-500, #8a94a6)',
                      }}
                    >
                      {owner || '+ Owner'}
                    </button>
                    {item.isCommitment && <span className="pp-meta">commitment</span>}

                    {pickerFor === i && (
                      <div
                        role="listbox"
                        aria-label="Choose owner"
                        style={{
                          position: 'absolute', top: '100%', left: 0, zIndex: 20, marginTop: 4, minWidth: 200, maxWidth: 260,
                          background: 'var(--surface, #fff)', border: '1px solid var(--line)', borderRadius: 10,
                          boxShadow: '0 6px 20px rgba(15, 30, 50, 0.12)', padding: 6,
                        }}
                      >
                        {ownerChoices.map((name) => (
                          <button
                            key={name}
                            role="option"
                            aria-selected={sameName(name, owner)}
                            onClick={() => chooseOwner(i, name)}
                            style={{
                              display: 'block', width: '100%', textAlign: 'left', fontSize: 12.5, padding: '6px 8px',
                              border: 'none', borderRadius: 6, cursor: 'pointer', color: 'var(--navy)',
                              background: sameName(name, owner) ? 'var(--surface-status, #eef6f6)' : 'transparent',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}
                          >
                            {name}
                          </button>
                        ))}
                        <input
                          autoFocus
                          placeholder="Type a name"
                          aria-label="Type an owner name"
                          value={typedName}
                          onChange={(e) => setTypedName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') chooseOwner(i, typedName);
                            if (e.key === 'Escape') setPickerFor(null);
                          }}
                          style={{ width: '100%', marginTop: 4, fontSize: 12.5, padding: '6px 8px', border: '1px solid var(--line)', borderRadius: 6, boxSizing: 'border-box' }}
                        />
                        {owner && (
                          <button
                            onClick={() => { setPickerFor(null); patch(i, { owner: null, assignee: null }); }}
                            style={{ display: 'block', width: '100%', textAlign: 'left', fontSize: 12, padding: '6px 8px', marginTop: 2, border: 'none', background: 'transparent', color: 'var(--slate-500, #8a94a6)', cursor: 'pointer' }}
                          >
                            Remove owner
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <button
                  aria-label="Delete action item"
                  title="Delete"
                  onClick={() => remove(i)}
                  style={{ border: 'none', background: 'transparent', color: 'var(--slate-500, #8a94a6)', fontSize: 16, lineHeight: 1, cursor: 'pointer', padding: '0 2px' }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

      {undo && (
        <div className="pp-row" role="status" style={{ gap: 10, padding: '6px 2px' }}>
          <span className="pp-meta">Action item deleted.</span>
          <button className="pp-quiet-action" onClick={restore}>Undo</button>
        </div>
      )}
      {error && <div role="alert" className="pp-meta" style={{ color: 'var(--red)' }}>{error}</div>}
    </>
  );
}
