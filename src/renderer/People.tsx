import React, { useState, useEffect } from 'react';

interface Person {
  id: string;
  name: string;
  email?: string;
  role?: string;
  company?: string;
  meeting_count: number;
}

function initials(name: string) {
  return name.split(' ').map(p => p[0]).join('').toUpperCase().slice(0, 2);
}

export default function People() {
  const [people, setPeople] = useState<Person[]>([]);

  useEffect(() => {
    (window as any).inwiseAPI.getPeople().then((data: Person[]) => setPeople(data || []));
  }, []);

  return (
    <>
      <div className="page-header">
        <div className="page-title">People</div>
        <div className="page-subtitle">{people.length} contact{people.length !== 1 ? 's' : ''} extracted from meetings</div>
      </div>
      <div className="page-body">
        {people.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">👥</div>
            <div className="empty-state-title">No people yet</div>
            <div>Participants are extracted automatically from meeting transcripts.</div>
          </div>
        ) : (
          <div className="people-grid">
            {people.map((p) => (
              <div key={p.id} className="person-card">
                <div className="person-avatar">{initials(p.name)}</div>
                <div className="person-name">{p.name}</div>
                {p.email && <div className="person-email">{p.email}</div>}
                {p.role && <div className="person-email">{p.role}{p.company ? ` · ${p.company}` : ''}</div>}
                <div className="person-meetings">{p.meeting_count} meeting{p.meeting_count !== 1 ? 's' : ''}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
