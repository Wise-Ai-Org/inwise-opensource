import React, { useEffect, useState } from 'react';
import { api } from './nav';
import { NativeTranscriptPicker } from '../Settings';

export default function GoogleMeetIntegrationRow() {
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fetchKey, setFetchKey] = useState(0);
  const [resolvedMeeting, setResolvedMeeting] = useState<any>(null);
  const [reference, setReference] = useState('');
  const [resolving, setResolving] = useState(false);
  const [lookupError, setLookupError] = useState('');

  const refresh = async () => {
    const status = await api().meetStatus();
    setConnected(!!status?.connected);
    setLoaded(true);
  };
  useEffect(() => { refresh().catch(() => setError('Could not check the connection.')); }, []);
  // Keep the hub visible when sign-in opens the browser.
  useEffect(() => {
    if (!busy) return;
    api().pinPopup?.(true);
    return () => { api().pinPopup?.(false); };
  }, [busy]);

  const toggle = async () => {
    setError('');
    setBusy(true);
    try {
      const result = connected ? await api().meetDisconnect() : await api().meetConnect();
      if (!result?.ok) throw new Error(result?.error || 'Could not change the connection.');
      setFetchKey(0);
      await refresh();
    } catch (error: any) { setError(error.message); }
    finally { setBusy(false); }
  };

  return <div>
    <div className="pp-setrow" style={{ cursor: 'default', gap: 10 }}>
      <span className="pp-seticon">M</span>
      <div className="pp-grow">
        <div className="pp-rowlabel">Google Meet</div>
        <div className="pp-rowsub" role="status">{busy ? connected ? 'Disconnecting…' : 'Connecting…' : !loaded ? 'Checking…' : connected ? 'Connected' : 'Disconnected'}</div>
      </div>
      <button className={`pp-toggle${connected ? ' pp-on' : ''}`} role="switch"
        aria-label="Google Meet connection" aria-checked={connected} disabled={!loaded || busy}
        onClick={toggle} />
      <button className="pp-btn pp-ghost" style={{ width: 'auto', margin: 0, padding: '5px 10px' }}
        disabled={!connected || busy} onClick={() => { setError(''); setResolvedMeeting(null); setFetchKey(key => key + 1); }}>Fetch</button>
    </div>
    {error && <div role="alert" className="pp-meta" style={{ padding: '0 16px 12px' }}>{error}</div>}
    {fetchKey > 0 && connected && <div style={{ padding: '0 16px 14px' }}>
      <details className="pp-meta" style={{ marginBottom: 12 }}>
        <summary>Find a shared call</summary>
        <div style={{ margin: '8px 0' }}>Use a meeting link while the call is active, or a conference record shared by its organizer.</div>
        <form onSubmit={async event => {
          event.preventDefault(); setResolving(true); setLookupError('');
          try {
            const result = await api().meetResolveConference(reference);
            if (!result?.ok) throw new Error(result?.error || 'Could not find this call.');
            setResolvedMeeting(result.meeting); setFetchKey(key => key + 1);
          } catch (error: any) { setLookupError(error.message); }
          finally { setResolving(false); }
        }}>
          <input className="form-input" aria-label="Meeting link or shared conference record" value={reference} onChange={event => setReference(event.target.value)} placeholder="Meeting link or conferenceRecords/…" />
          <button className="pp-btn pp-ghost" disabled={resolving || !reference.trim()}>{resolving ? 'Finding…' : 'Find'}</button>
        </form>
        {lookupError && <div role="alert">{lookupError}</div>}
      </details>
      <NativeTranscriptPicker key={fetchKey} platform="Google Meet" autoLoad onClose={() => setFetchKey(0)}
        listMeetings={() => resolvedMeeting ? Promise.resolve({ ok: true, meetings: [resolvedMeeting] }) : api().meetListMeetings()}
        fetchAttendance={meeting => api().meetFetchAttendance(meeting)}
        fetchTranscript={meeting => api().meetFetchTranscript(meeting)}
        itemKey={meeting => meeting.name} />
    </div>}
  </div>;
}
