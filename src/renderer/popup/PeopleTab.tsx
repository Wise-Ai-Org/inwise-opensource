import React, { useCallback, useEffect, useState } from 'react';
import { api, initials, useNav } from './nav';
import { useReview } from './PopupShell';

interface PersonRow {
  _id: string;
  name: string;
  company: string | null;
  role: string | null;
  meetingCount: number;
  actionItemCount: number;
  daysSinceLastContact: number | null;
}

export default function PeopleTab() {
  const { push } = useNav();
  const review = useReview();
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [archivedCount, setArchivedCount] = useState(0);
  const [archived, setArchived] = useState<PersonRow[] | null>(null); // null = collapsed
  const [query, setQuery] = useState('');
  const [addName, setAddName] = useState('');
  const [adding, setAdding] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback((search?: string) => {
    const a = api();
    a.getPeople?.(search || undefined).then((rows: any[]) => {
      setPeople(Array.isArray(rows) ? rows : []);
      setLoaded(true);
    }).catch(() => setLoaded(true));
    a.getArchivedPeople?.().then((rows: any[]) => setArchivedCount(Array.isArray(rows) ? rows.length : 0)).catch(() => {});
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    const t = setTimeout(() => reload(query.trim() || undefined), 250);
    return () => clearTimeout(t);
  }, [query, reload]);

  const addPerson = async () => {
    const name = addName.trim();
    if (!name) { setAdding(false); return; }
    setAddName('');
    setAdding(false);
    await api().addPerson?.({ name });
    reload();
  };

  const subtitle = (p: PersonRow): string => {
    const bits: string[] = [];
    if (p.role) bits.push(p.role);
    else if (p.company) bits.push(p.company);
    if (p.actionItemCount > 0) bits.push(`${p.actionItemCount} open item${p.actionItemCount === 1 ? '' : 's'}`);
    else if (p.daysSinceLastContact != null) bits.push(`last met ${p.daysSinceLastContact === 0 ? 'today' : `${p.daysSinceLastContact}d ago`}`);
    return bits.join(' · ') || `${p.meetingCount} meeting${p.meetingCount === 1 ? '' : 's'}`;
  };

  return (
    <div className="pp-body">
      <div className="pp-search">
        <span style={{ color: 'var(--slate-300)' }}>⌕</span>
        <input placeholder="Search people…" value={query} onChange={e => setQuery(e.target.value)} />
      </div>

      <div className="pp-row" style={{ justifyContent: 'space-between', padding: '0 2px' }}>
        {review.suggested.length > 0 ? (
          <button className="pp-link" onClick={() => push({ kind: 'review', focus: 'people' })}>
            AI suggested ({review.suggested.length})
          </button>
        ) : <span />}
        <button className="pp-link" onClick={() => setAdding(a => !a)}>+ Add person</button>
      </div>

      {adding && (
        <div className="pp-search">
          <input
            autoFocus
            placeholder="Name — Enter to add"
            value={addName}
            onChange={e => setAddName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') addPerson();
              if (e.key === 'Escape') { setAdding(false); setAddName(''); }
            }}
          />
        </div>
      )}

      {loaded && people.length === 0 && (
        <div className="pp-meta" style={{ textAlign: 'center', padding: '28px 0' }}>
          {query ? 'No one matches that search.' : 'No people tracked yet — they appear as you record meetings.'}
        </div>
      )}

      {people.length > 0 && (
        <div className="pp-listcard">
          {people.map(p => (
            <button key={p._id} className="pp-setrow" onClick={() => push({ kind: 'person', id: p._id, name: p.name })}>
              <span className="pp-avatar">{initials(p.name)}</span>
              <div className="pp-grow">
                <div className="pp-rowlabel">{p.name}</div>
                <div className="pp-rowsub">{subtitle(p)}</div>
              </div>
              <span className="pp-chevron">›</span>
            </button>
          ))}
        </div>
      )}

      {archivedCount > 0 && archived === null && (
        <div className="pp-row" style={{ justifyContent: 'center' }}>
          <button
            className="pp-quiet-action"
            onClick={() => api().getArchivedPeople?.().then((rows: any[]) => setArchived(Array.isArray(rows) ? rows : []))}
          >
            Archived ({archivedCount})
          </button>
        </div>
      )}

      {archived !== null && (
        <>
          <div className="pp-row" style={{ justifyContent: 'space-between', padding: '0 2px' }}>
            <span className="pp-seclabel" style={{ padding: 0 }}>Archived</span>
            <button className="pp-quiet-action" onClick={() => setArchived(null)}>Hide</button>
          </div>
          <div className="pp-listcard">
            {archived.map(p => (
              <div key={p._id} className="pp-setrow" style={{ cursor: 'default' }}>
                <span className="pp-avatar" style={{ opacity: 0.6 }}>{initials(p.name)}</span>
                <div className="pp-grow">
                  <div className="pp-rowlabel" style={{ color: 'var(--slate-500)' }}>{p.name}</div>
                </div>
                <button className="pp-link" onClick={async () => {
                  await api().unarchivePerson?.(p._id);
                  setArchived(null);
                  reload();
                }}>Restore</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
