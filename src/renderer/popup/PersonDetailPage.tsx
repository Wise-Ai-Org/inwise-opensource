import React, { useEffect, useState } from 'react';
import { api, initials, useNav } from './nav';

export default function PersonDetailPage({ personId }: { personId: string }) {
  const { pop, push } = useNav();
  const [person, setPerson] = useState<any>(null);
  const [loaded, setLoaded] = useState(false);
  const [agenda, setAgenda] = useState<string[] | null>(null);
  const [agendaLoading, setAgendaLoading] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  useEffect(() => {
    api().getPerson?.(personId)
      .then((p: any) => setPerson(p))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [personId]);

  const openItems: any[] = person?.pendingActionItems || [];
  const meetings: any[] = (person?.communications || []).slice(0, 5);

  const lastMet = person?.lastMeeting
    ? new Date(person.lastMeeting).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    : null;

  const generateAgenda = async () => {
    setAgendaLoading(true);
    try {
      const res = await api().generateAgenda?.(personId);
      const items: string[] =
        Array.isArray(res) ? res :
        Array.isArray(res?.agenda) ? res.agenda :
        typeof res === 'string' ? res.split('\n').filter(Boolean) :
        typeof res?.text === 'string' ? res.text.split('\n').filter(Boolean) : [];
      setAgenda(items.length ? items : ['Nothing to suggest yet — record a meeting together first.']);
    } catch {
      setAgenda(['Could not generate talking points — check your AI key in Settings.']);
    } finally {
      setAgendaLoading(false);
    }
  };

  const doArchive = async () => {
    await api().archivePerson?.(personId);
    pop();
  };

  return (
    <>
      <div className="pp-drillhead">
        <button className="pp-back" aria-label="Back" onClick={pop}>←</button>
        <div className="pp-drilltitle">{person?.name || 'Person'}</div>
        <span />
      </div>
      <div className="pp-body" style={{ paddingTop: 4 }}>
        {!loaded && <div className="pp-meta" style={{ textAlign: 'center', padding: 20 }}>Loading…</div>}
        {loaded && !person && <div className="pp-meta" style={{ textAlign: 'center', padding: 20 }}>Person not found.</div>}
        {person && (
          <>
            <div className="pp-card">
              <div className="pp-row">
                <span className="pp-avatar" style={{ width: 42, height: 42, fontSize: 14 }}>{initials(person.name || '?')}</span>
                <div className="pp-grow">
                  <div className="pp-title-sm" style={{ fontSize: 15 }}>{person.name}</div>
                  <div className="pp-meta" style={{ marginTop: 2 }}>
                    {[person.role || person.company, lastMet ? `last met ${lastMet}` : null].filter(Boolean).join(' · ')
                      || `${meetings.length} meeting${meetings.length === 1 ? '' : 's'} together`}
                  </div>
                </div>
              </div>
            </div>

            {agenda ? (
              <div className="pp-card" style={{ background: 'var(--pp-teal-tint)', borderColor: 'var(--pp-teal-line)' }}>
                <div className="pp-row" style={{ marginBottom: 8 }}>
                  <div className="pp-grow" style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--pp-teal-deep)' }}>
                    Talking points
                  </div>
                  <button className="pp-quiet-action" aria-label="Dismiss" onClick={() => setAgenda(null)}>✕</button>
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {agenda.map((item, i) => (
                    <li key={i} style={{ fontSize: 12.5, color: 'var(--slate-700)', lineHeight: 1.5 }}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <button className="pp-btn pp-ghost" onClick={generateAgenda} disabled={agendaLoading}>
                {agendaLoading ? 'Thinking…' : 'Draft talking points for next time'}
              </button>
            )}

            {openItems.length > 0 && (
              <>
                <div className="pp-seclabel">Open items</div>
                <div className="pp-listcard">
                  {openItems.slice(0, 6).map((item: any, i: number) => (
                    <div key={i} className="pp-setrow" style={{ cursor: 'default' }}>
                      <div className="pp-grow">
                        <div style={{ fontSize: 12.5, color: 'var(--navy)', lineHeight: 1.4 }}>{item.text}</div>
                        <div className="pp-rowsub">
                          {[item.assignee ? `Owner: ${item.assignee}` : 'Unassigned', item.dueDate || null].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {meetings.length > 0 && (
              <>
                <div className="pp-seclabel">Recent meetings together</div>
                <div className="pp-listcard">
                  {meetings.map((m: any) => (
                    <button key={m._id} className="pp-setrow" onClick={() => push({ kind: 'meeting', id: m._id, title: m.title })}>
                      <div className="pp-grow">
                        <div className="pp-rowlabel" style={{ fontSize: 13 }}>{m.title}</div>
                        <div className="pp-rowsub">
                          {new Date(m.date).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                          {m.actionItems?.length ? ` · ${m.actionItems.length} action item${m.actionItems.length === 1 ? '' : 's'}` : ''}
                        </div>
                      </div>
                      <span className="pp-chevron">›</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            <div className="pp-row" style={{ justifyContent: 'center', paddingTop: 2 }}>
              {confirmArchive ? (
                <span className="pp-row" style={{ gap: 10 }}>
                  <span className="pp-meta">Archive {person.name}?</span>
                  <button className="pp-quiet-action" style={{ color: 'var(--red)' }} onClick={doArchive}>Archive</button>
                  <button className="pp-quiet-action" onClick={() => setConfirmArchive(false)}>Cancel</button>
                </span>
              ) : (
                <button className="pp-quiet-action" onClick={() => setConfirmArchive(true)}>Archive person</button>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
