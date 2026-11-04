import React, { useState } from 'react';

export default function NativeTranscriptSync({ provider }: { provider: 'meet' | 'teams' | 'zoom' }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const sync = async () => {
    setBusy(true);
    try {
      const result = await (window as any).inwiseAPI.syncNativeTranscripts(provider);
      setMessage(result.ok
        ? `${result.imported} imported, ${result.skipped} already imported, ${result.unavailable ?? result.pending ?? 0} without a ready transcript.${result.errors?.length ? ` ${result.errors.join(' ')}` : result.failed ? ` ${result.failed} imports failed. Check the connection and try again.` : ''}`
        : result.error);
    } catch { setMessage('Could not sync transcripts. Check the connection and try again.'); }
    finally { setBusy(false); }
  };
  return <div style={{ marginBottom: 16, fontSize: 12, lineHeight: 1.6 }}>
    <div>While Inwise is open, available native transcripts are checked every 15 minutes. No desktop recording is needed. Transcription must be enabled in the meeting service.</div>
    <button className="btn btn-secondary btn-sm" style={{ marginTop: 8 }} disabled={busy} onClick={sync}>{busy ? 'Syncing transcripts…' : 'Sync now'}</button>
    {message && <div role="status" style={{ marginTop: 8 }}>{message}</div>}
  </div>;
}
