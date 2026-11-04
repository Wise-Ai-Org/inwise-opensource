import React, { useEffect, useState } from 'react';
import { api } from './nav';
import { NativeTranscriptPicker } from '../Settings';

export default function TeamsIntegrationRow() {
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fetchKey, setFetchKey] = useState(0);

  const refresh = async () => {
    const status = await api().teamsStatus();
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
      const result = connected ? await api().teamsDisconnect() : await api().teamsConnect();
      if (!result?.ok) throw new Error(result?.error || 'Could not change the connection.');
      setFetchKey(0);
      await refresh();
    } catch (error: any) { setError(error.message); }
    finally { setBusy(false); }
  };

  return <div>
    <div className="pp-setrow" style={{ cursor: 'default', gap: 10 }}>
      <span className="pp-seticon">T</span>
      <div className="pp-grow">
        <div className="pp-rowlabel">Microsoft Teams</div>
        <div className="pp-rowsub" role="status">{busy ? connected ? 'Disconnecting…' : 'Connecting…' : !loaded ? 'Checking…' : connected ? 'Connected' : 'Disconnected'}</div>
      </div>
      <button className={`pp-toggle${connected ? ' pp-on' : ''}`} role="switch"
        aria-label="Microsoft Teams connection" aria-checked={connected} disabled={!loaded || busy}
        onClick={toggle} />
      <button className="pp-btn pp-ghost" style={{ width: 'auto', margin: 0, padding: '5px 10px' }}
        disabled={!connected || busy} onClick={() => { setError(''); setFetchKey(key => key + 1); }}>Fetch</button>
    </div>
    {error && <div role="alert" className="pp-meta" style={{ padding: '0 16px 12px' }}>{error}</div>}
    {fetchKey > 0 && connected && <div style={{ padding: '0 16px 14px' }}>
      <NativeTranscriptPicker key={fetchKey} platform="Microsoft Teams" autoLoad onClose={() => setFetchKey(0)}
        listMeetings={() => api().teamsListMeetings()}
        fetchAttendance={meeting => api().teamsFetchAttendance(meeting)}
        fetchTranscript={meeting => api().teamsFetchTranscript(meeting)}
        itemKey={meeting => meeting.eventId} />
    </div>}
  </div>;
}
