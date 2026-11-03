import React, { useEffect, useState } from 'react';
import { api } from './nav';
import './ollie.css';

export interface PickedJiraUser { accountId: string; displayName: string; email: string | null }

/**
 * "Find in Jira": search Jira users by name and pick one. Inline, so it works
 * inside a People row, a recap row or a Review card at tray width.
 */
export function JiraUserPicker({ initialQuery, onPick, onCancel }: {
  initialQuery: string;
  onPick: (user: PickedJiraUser) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<PickedJiraUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    let live = true;
    const t = setTimeout(() => {
      api().jiraSearchUsers?.(q).then((res: any) => {
        if (!live) return;
        if (res?.ok === false) { setError(res.error || 'Jira search did not work.'); setResults([]); return; }
        setError(null);
        setResults(Array.isArray(res?.users) ? res.users : []);
      }).catch(() => { if (live) { setError('Jira search did not work.'); setResults([]); } });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [query]);

  return (
    <div className="ol-picker" onClick={e => e.stopPropagation()}>
      <div className="ol-row-sub">Pick {initialQuery ? `${initialQuery}'s` : 'their'} Jira account</div>
      <input
        className="ol-picker-input"
        aria-label="Search Jira people"
        placeholder="Search Jira by name"
        value={query}
        autoFocus
        onChange={e => setQuery(e.target.value)}
      />
      {error && <div className="ol-row-sub ol-warn-text">{error}</div>}
      {results && results.length === 0 && !error && query.trim().length >= 2 && (
        <div className="ol-note">Nobody in Jira matches “{query.trim()}”.</div>
      )}
      {results && results.map(u => (
        <button
          key={u.accountId}
          className="ol-picker-option"
          disabled={busy}
          onClick={async () => { setBusy(true); try { await onPick(u); } finally { setBusy(false); } }}
        >
          <span className="ol-row-title">{u.displayName}</span>
          {u.email && <span className="ol-row-sub">{u.email}</span>}
        </button>
      ))}
      <button className="ol-btn ol-quiet" onClick={onCancel}>Cancel</button>
    </div>
  );
}

let jiraConnectedOnce: Promise<boolean> | null = null;
/** Jira connection, read once per popup session. */
export function useJiraConnected(): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!jiraConnectedOnce) jiraConnectedOnce = Promise.resolve(api().jiraStatus?.()).then((s: any) => !!s?.connected).catch(() => false);
    let live = true;
    jiraConnectedOnce.then(v => { if (live) setConnected(v); });
    return () => { live = false; };
  }, []);
  return connected;
}

/**
 * A person's Jira link. Unresolved (Jira hides their email, or you unlinked):
 * "Not linked to Jira yet" with Find in Jira. Linked: the account name and,
 * on the person page, Unlink.
 */
export function JiraLinkNote({ person, allowUnlink, onChanged }: {
  person: { _id: string; name?: string; jiraLink?: { status: string; displayName?: string | null } | null };
  allowUnlink?: boolean;
  onChanged: () => void;
}) {
  const connected = useJiraConnected();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = person.jiraLink;
  if (!connected || !link) return null;
  const linked = link.status === 'linked' || link.status === 'email';
  if (linked && !allowUnlink) return null;
  return (
    <div className={`ol-jira-note ${allowUnlink ? "ol-jira-note-inline" : ""}`} onClick={e => e.stopPropagation()}>
      {linked ? (
        <div className="ol-jira-note-row">
          <span>Linked to Jira as {link.displayName || person.name}</span>
          <button className="ol-btn ol-quiet" onClick={async () => { await api().peopleUnlinkJira?.(person._id); onChanged(); }}>Unlink</button>
        </div>
      ) : picking ? (
        <JiraUserPicker
          initialQuery={person.name || ''}
          onCancel={() => setPicking(false)}
          onPick={async u => {
            const res = await api().peopleSetJiraAccount?.(person._id, { accountId: u.accountId, displayName: u.displayName });
            if (res && res.ok === false) { setError(res.error || 'Could not save the link.'); return; }
            setPicking(false);
            onChanged();
          }}
        />
      ) : (
        <div className="ol-jira-note-row">
          <span>Not linked to Jira yet</span>
          <button className="ol-btn" onClick={() => { setError(null); setPicking(true); }}>Find in Jira</button>
        </div>
      )}
      {error && <div className="ol-row-sub ol-warn-text">{error}</div>}
    </div>
  );
}
