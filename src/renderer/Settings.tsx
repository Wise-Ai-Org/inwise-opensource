import React, { useState, useEffect, useRef } from 'react';

interface Config {
  apiProvider: 'anthropic' | 'openai';
  apiKey: string;
  whisperModel: 'tiny' | 'base' | 'small' | 'medium';
  micDeviceId: string;
  userName: string;
  selfEmails: string[];
  jiraClientId: string;
  jiraClientSecret: string;
  jiraAutoPush: boolean;
  jiraDefaultProject: string;
  slackBotToken: string;
  slackReadChannels: string[];
  slackWriteChannels: string[];
  slackInactivityWindowMin: number;
}

type CalendarProviderUI = 'google' | 'outlook' | 'ics';

interface CalendarRow {
  id: string;
  label: string;
  provider: CalendarProviderUI;
  url: string;
  enabled: boolean;
}

interface VoicePrintInfo {
  _id: string;
  name: string;
  isUser: boolean;
  personId: string | null;
  createdAt: string;
  hasAudio: boolean;
}

type TestStatus = 'idle' | 'testing' | 'ok' | 'error';

interface CalendarHealthInfo {
  status: 'unknown' | 'ok' | 'error' | 'no-url';
  lastPollAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  eventCount: number;
  googleConfigured: boolean;
  outlookConfigured: boolean;
}

function CalendarStatus() {
  const [health, setHealth] = useState<CalendarHealthInfo | null>(null);

  useEffect(() => {
    let mounted = true;
    const fetch = () => {
      (window as any).inwiseAPI.getCalendarHealth().then((h: CalendarHealthInfo) => {
        if (mounted) setHealth(h);
      });
    };
    fetch();
    const interval = setInterval(fetch, 15_000); // refresh every 15s
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  if (!health || health.status === 'unknown') return null;

  if (health.status === 'no-url') {
    return (
      <div style={{
        padding: '12px 16px', borderRadius: 8, marginBottom: 20,
        background: 'var(--slate-50)', border: '1px solid var(--slate-200)',
      }}>
        <div style={{ fontSize: 13, color: 'var(--slate-500)' }}>
          No calendar connected yet. Add your ICS link below to get started.
        </div>
      </div>
    );
  }

  if (health.status === 'error') {
    const ago = health.lastSuccessAt
      ? formatAgo(health.lastSuccessAt)
      : null;
    return (
      <div style={{
        padding: '12px 16px', borderRadius: 8, marginBottom: 20,
        background: '#FEF2F2', border: '1px solid #FECACA',
      }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: '#DC2626', marginBottom: 4 }}>
          Calendar sync failing
        </div>
        <div style={{ fontSize: 13, color: '#991B1B', lineHeight: 1.5 }}>
          {health.lastError}
        </div>
        {ago && (
          <div style={{ fontSize: 12, color: '#B91C1C', marginTop: 6 }}>
            Last successful sync: {ago}
          </div>
        )}
        <div style={{ fontSize: 12, color: '#991B1B', marginTop: 8, lineHeight: 1.5 }}>
          Try re-copying the ICS link from your calendar settings below. Google secret ICS URLs
          can expire if you reset your calendar sharing or change your password.
        </div>
      </div>
    );
  }

  // status === 'ok'
  const ago = health.lastSuccessAt ? formatAgo(health.lastSuccessAt) : '';
  return (
    <div style={{
      padding: '12px 16px', borderRadius: 8, marginBottom: 20,
      background: '#F0FDF9', border: '1px solid #CCFBF1',
    }}>
      <div style={{ fontSize: 13, color: '#115E59' }}>
        <span style={{ fontWeight: 600 }}>Calendar connected</span> — {health.eventCount} upcoming event{health.eventCount !== 1 ? 's' : ''} found
        {ago && <span style={{ color: '#5EEAD4', marginLeft: 8 }}>· synced {ago}</span>}
      </div>
    </div>
  );
}

function formatAgo(epochMs: number): string {
  const diffSec = Math.round((Date.now() - epochMs) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function CalendarRowView({
  row,
  autoFocus,
  onPatch,
  onRemove,
}: {
  row: CalendarRow;
  autoFocus: boolean;
  onPatch: (id: string, patch: Partial<Omit<CalendarRow, 'id'>>) => void;
  onRemove: (id: string) => void;
}) {
  const [label, setLabel] = useState(row.label);
  const [url, setUrl] = useState(row.url);
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testMsg, setTestMsg] = useState('');
  const labelDebouncer = useRef<number | null>(null);
  const urlDebouncer = useRef<number | null>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus && labelInputRef.current) {
      labelInputRef.current.focus();
    }
  }, [autoFocus]);

  useEffect(() => {
    return () => {
      if (labelDebouncer.current) window.clearTimeout(labelDebouncer.current);
      if (urlDebouncer.current) window.clearTimeout(urlDebouncer.current);
    };
  }, []);

  const debouncedSave = (key: 'label' | 'url', value: string) => {
    const ref = key === 'label' ? labelDebouncer : urlDebouncer;
    if (ref.current) window.clearTimeout(ref.current);
    ref.current = window.setTimeout(() => onPatch(row.id, { [key]: value } as any), 500);
  };

  const test = async () => {
    if (!url.trim()) return;
    setTestStatus('testing');
    setTestMsg('');
    const result = await (window as any).inwiseAPI.testCalendarUrl(url.trim());
    if (result.ok) {
      setTestStatus('ok');
      setTestMsg(`Connected — ${result.eventCount} upcoming event${result.eventCount !== 1 ? 's' : ''} found`);
    } else {
      setTestStatus('error');
      setTestMsg(result.error || 'Could not read calendar. Double-check the URL.');
    }
  };

  const statusColor = testStatus === 'ok' ? 'var(--teal)' : testStatus === 'error' ? 'var(--red)' : 'var(--slate-500)';

  return (
    <div style={{
      padding: 14,
      marginBottom: 12,
      border: '1px solid var(--slate-200)',
      borderRadius: 8,
      background: row.enabled ? 'white' : 'var(--slate-50)',
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <input
          ref={labelInputRef}
          className="form-input"
          style={{ flex: 1, fontWeight: 600 }}
          value={label}
          onChange={e => { setLabel(e.target.value); debouncedSave('label', e.target.value); }}
          onBlur={() => {
            if (labelDebouncer.current) window.clearTimeout(labelDebouncer.current);
            onPatch(row.id, { label });
          }}
          placeholder="Calendar name (e.g. Work, Personal)"
        />
        <select
          className="form-select"
          style={{ width: 120, flexShrink: 0 }}
          value={row.provider}
          onChange={e => onPatch(row.id, { provider: e.target.value as CalendarProviderUI })}
        >
          <option value="google">Google</option>
          <option value="outlook">Outlook</option>
          <option value="ics">Other</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', flexShrink: 0 }}>
          <input
            type="checkbox"
            checked={row.enabled}
            onChange={e => onPatch(row.id, { enabled: e.target.checked })}
          />
          <span style={{ fontSize: 13, color: 'var(--slate-700)' }}>Enabled</span>
        </label>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          className="form-input"
          style={{ flex: 1 }}
          value={url}
          onChange={e => { setUrl(e.target.value); setTestStatus('idle'); debouncedSave('url', e.target.value); }}
          onBlur={() => {
            if (urlDebouncer.current) window.clearTimeout(urlDebouncer.current);
            onPatch(row.id, { url });
          }}
          placeholder="https://… (paste your secret ICS link)"
        />
        <button
          className="btn btn-secondary btn-sm"
          onClick={test}
          disabled={!url.trim() || testStatus === 'testing'}
          style={{ flexShrink: 0 }}
        >
          {testStatus === 'testing' ? 'Testing…' : 'Test'}
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => onRemove(row.id)}
          style={{ flexShrink: 0, color: 'var(--red)' }}
        >
          Delete
        </button>
      </div>

      {testStatus !== 'idle' && (
        <div style={{ fontSize: 12, color: statusColor, marginTop: 8 }}>
          {testStatus === 'ok' && '✓ '}{testStatus === 'error' && '✕ '}{testMsg}
        </div>
      )}
    </div>
  );
}

function CalendarList() {
  const [rows, setRows] = useState<CalendarRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [newlyAddedId, setNewlyAddedId] = useState<string | null>(null);

  useEffect(() => {
    (window as any).inwiseAPI.listCalendars().then((list: CalendarRow[]) => {
      setRows(list);
      setLoaded(true);
    });
  }, []);

  const handleAdd = async () => {
    const created = await (window as any).inwiseAPI.addCalendar({
      label: '',
      provider: 'ics' as CalendarProviderUI,
      url: '',
      enabled: true,
    });
    setRows(prev => [...prev, created]);
    setNewlyAddedId(created.id);
  };

  const handleRemove = async (id: string) => {
    if (!window.confirm('Remove this calendar? Events from this calendar will disappear from your upcoming list.')) return;
    await (window as any).inwiseAPI.removeCalendar(id);
    setRows(prev => prev.filter(r => r.id !== id));
  };

  const handlePatch = async (id: string, patch: Partial<Omit<CalendarRow, 'id'>>) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
    await (window as any).inwiseAPI.updateCalendar(id, patch);
  };

  if (!loaded) return null;

  return (
    <div>
      {rows.length === 0 ? (
        <div style={{
          padding: '20px 16px',
          border: '1px dashed var(--slate-300)',
          borderRadius: 8,
          textAlign: 'center',
          color: 'var(--slate-500)',
          fontSize: 13,
          lineHeight: 1.5,
          marginBottom: 12,
        }}>
          Add your first calendar to get started — paste a secret ICS link from your calendar settings.
        </div>
      ) : (
        rows.map(row => (
          <CalendarRowView
            key={row.id}
            row={row}
            autoFocus={row.id === newlyAddedId}
            onPatch={handlePatch}
            onRemove={handleRemove}
          />
        ))
      )}
      <button className="btn btn-secondary btn-sm" onClick={handleAdd}>
        + Add calendar
      </button>
      <div style={{ fontSize: 12, color: 'var(--slate-400)', marginTop: 10, lineHeight: 1.5 }}>
        ⏱ Changes to calendars refresh automatically. New events from Google can take 5–15 minutes to appear;
        Outlook ICS feeds can take 15–60 minutes. Disabled calendars are skipped on the next poll.
      </div>
    </div>
  );
}

function MicTest({ deviceId }: { deviceId: string }) {
  const [status, setStatus] = useState<'idle' | 'testing' | 'transcribing' | 'done' | 'error'>('idle');
  const [level, setLevel] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const rafRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);

  const runTest = async () => {
    setStatus('testing');
    setLevel(0);
    setTranscript('');
    setErrorMsg('');
    try {
      const constraint = deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : true;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: constraint as any });
      streamRef.current = stream;

      // Level meter
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setLevel(Math.min(100, (avg / 128) * 100));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();

      // Capture audio
      const chunks: Blob[] = [];
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      mr.start(250);

      setTimeout(async () => {
        try {
          cancelAnimationFrame(rafRef.current);
          mr.stop();
          stream.getTracks().forEach(t => t.stop());
          setLevel(0);
          setStatus('transcribing');

          await new Promise<void>(resolve => { mr.onstop = () => resolve(); });

          // Convert to WAV
          const blob = new Blob(chunks, { type: 'audio/webm' });
          const arrayBuffer = await blob.arrayBuffer();
          const audioCtx = new AudioContext({ sampleRate: 16000 });
          const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
          audioCtx.close();
          ctx.close();

          const pcm = decoded.getChannelData(0);
          const samples = new Int16Array(pcm.length);
          for (let i = 0; i < pcm.length; i++) {
            samples[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
          }
          const dataLength = samples.length * 2;
          const wav = new ArrayBuffer(44 + dataLength);
          const view = new DataView(wav);
          const write = (off: number, str: string) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
          write(0, 'RIFF'); view.setUint32(4, 36 + dataLength, true);
          write(8, 'WAVE'); write(12, 'fmt '); view.setUint32(16, 16, true);
          view.setUint16(20, 1, true); view.setUint16(22, 1, true);
          view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
          view.setUint16(32, 2, true); view.setUint16(34, 16, true);
          write(36, 'data'); view.setUint32(40, dataLength, true);
          new Int16Array(wav, 44).set(samples);

          const result = await (window as any).inwiseAPI.testMic(new Uint8Array(wav));
          if (result.ok) {
            setTranscript(result.transcript);
            setStatus('done');
          } else {
            setErrorMsg(result.error || 'Transcription failed');
            setStatus('error');
          }
        } catch (e: any) {
          setErrorMsg(e.message || 'Processing failed');
          setStatus('error');
        }
      }, 3000);
    } catch (e: any) {
      setStatus('error');
      setErrorMsg(e.message || 'Could not access microphone');
    }
  };

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  return (
    <div style={{ marginTop: 12 }}>
      {status === 'testing' && (
        <div>
          <div style={{ fontSize: 12, color: 'var(--slate-500)', marginBottom: 6 }}>Speak now — recording for 3 seconds…</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, height: 8, background: 'var(--slate-200)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${level}%`, height: '100%', background: '#6366f1', borderRadius: 4, transition: 'width 0.05s' }} />
            </div>
            <span style={{ fontSize: 12, color: 'var(--slate-500)', minWidth: 32 }}>{Math.round(level)}%</span>
          </div>
        </div>
      )}
      {status === 'transcribing' && (
        <div style={{ fontSize: 12, color: 'var(--slate-500)' }}>Transcribing…</div>
      )}
      {(status === 'idle' || status === 'done' || status === 'error') && (
        <button className="btn btn-secondary btn-sm" onClick={runTest}>
          {status === 'done' || status === 'error' ? 'Test Again' : 'Test Microphone'}
        </button>
      )}
      {status === 'done' && (
        <div style={{ marginTop: 8, padding: '8px 12px', background: 'var(--slate-100)', borderRadius: 8, fontSize: 13, color: 'var(--slate-700)', lineHeight: 1.5 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--teal)', display: 'block', marginBottom: 4 }}>TRANSCRIPT</span>
          {transcript}
        </div>
      )}
      {status === 'error' && (
        <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>✕ {errorMsg}</div>
      )}
    </div>
  );
}

function SystemAudioTest() {
  const [status, setStatus] = useState<'idle' | 'testing' | 'transcribing' | 'done' | 'error'>('idle');
  const [level, setLevel] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const rafRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);

  const runTest = async () => {
    setStatus('testing');
    setLevel(0);
    setTranscript('');
    setErrorMsg('');
    try {
      const sourceId = await (window as any).inwiseAPI.getDesktopSourceId();
      if (!sourceId) {
        setErrorMsg('System audio capture not available on this device');
        setStatus('error');
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } } as any,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } } as any,
      });
      // Drop video tracks
      stream.getVideoTracks().forEach(t => t.stop());
      streamRef.current = stream;

      // Level meter
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setLevel(Math.min(100, (avg / 128) * 100));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();

      // Capture audio
      const chunks: Blob[] = [];
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      mr.start(250);

      setTimeout(async () => {
        try {
          cancelAnimationFrame(rafRef.current);
          mr.stop();
          stream.getTracks().forEach(t => t.stop());
          setLevel(0);
          setStatus('transcribing');

          await new Promise<void>(resolve => { mr.onstop = () => resolve(); });

          const blob = new Blob(chunks, { type: 'audio/webm' });
          const arrayBuffer = await blob.arrayBuffer();
          const audioCtx = new AudioContext({ sampleRate: 16000 });
          const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
          audioCtx.close();
          ctx.close();

          const pcm = decoded.getChannelData(0);
          const samples = new Int16Array(pcm.length);
          for (let i = 0; i < pcm.length; i++) {
            samples[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
          }
          const dataLength = samples.length * 2;
          const wav = new ArrayBuffer(44 + dataLength);
          const view = new DataView(wav);
          const write = (off: number, str: string) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
          write(0, 'RIFF'); view.setUint32(4, 36 + dataLength, true);
          write(8, 'WAVE'); write(12, 'fmt '); view.setUint32(16, 16, true);
          view.setUint16(20, 1, true); view.setUint16(22, 1, true);
          view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
          view.setUint16(32, 2, true); view.setUint16(34, 16, true);
          write(36, 'data'); view.setUint32(40, dataLength, true);
          new Int16Array(wav, 44).set(samples);

          const result = await (window as any).inwiseAPI.testMic(new Uint8Array(wav));
          if (result.ok) {
            setTranscript(result.transcript);
            setStatus('done');
          } else {
            setErrorMsg(result.error || 'Transcription failed');
            setStatus('error');
          }
        } catch (e: any) {
          setErrorMsg(e.message || 'Processing failed');
          setStatus('error');
        }
      }, 5000);
    } catch (e: any) {
      setStatus('error');
      setErrorMsg(e.message || 'Could not capture system audio');
    }
  };

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  return (
    <div style={{ marginTop: 12 }}>
      {status === 'testing' && (
        <div>
          <div style={{ fontSize: 12, color: 'var(--slate-500)', marginBottom: 6 }}>Play audio on your device now — recording for 5 seconds…</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, height: 8, background: 'var(--slate-200)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${level}%`, height: '100%', background: '#f59e0b', borderRadius: 4, transition: 'width 0.05s' }} />
            </div>
            <span style={{ fontSize: 12, color: 'var(--slate-500)', minWidth: 32 }}>{Math.round(level)}%</span>
          </div>
        </div>
      )}
      {status === 'transcribing' && (
        <div style={{ fontSize: 12, color: 'var(--slate-500)' }}>Transcribing…</div>
      )}
      {(status === 'idle' || status === 'done' || status === 'error') && (
        <button className="btn btn-secondary btn-sm" onClick={runTest}>
          {status === 'done' || status === 'error' ? 'Test Again' : 'Test System Audio'}
        </button>
      )}
      {status === 'done' && (
        <div style={{ marginTop: 8, padding: '8px 12px', background: 'var(--slate-100)', borderRadius: 8, fontSize: 13, color: 'var(--slate-700)', lineHeight: 1.5 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#f59e0b', display: 'block', marginBottom: 4 }}>SYSTEM AUDIO TRANSCRIPT</span>
          {transcript}
        </div>
      )}
      {status === 'error' && (
        <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>✕ {errorMsg}</div>
      )}
    </div>
  );
}

// ── Slack Settings ─────────────────────────────────────────────────────────

function SlackSettings() {
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<{ connected: boolean } | null>(null);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [teamName, setTeamName] = useState<string | undefined>();
  const [botName, setBotName] = useState<string | undefined>();

  useEffect(() => {
    (window as any).inwiseAPI.slackStatus?.().then((s: any) => setStatus(s));
  }, []);

  const connect = async () => {
    if (!token.trim()) return;
    setValidating(true);
    setError(null);
    try {
      const result = await (window as any).inwiseAPI.slackConnect?.(token.trim());
      if (result?.ok) {
        setStatus({ connected: true });
        setTeamName(result.teamName);
        setBotName(result.botName);
        setToken('');
      } else {
        setError(result?.error ?? 'Invalid token');
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setValidating(false);
    }
  };

  const disconnect = async () => {
    await (window as any).inwiseAPI.slackDisconnect?.();
    setStatus({ connected: false });
    setTeamName(undefined);
    setBotName(undefined);
  };

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--slate-500)', marginBottom: 16, lineHeight: 1.6 }}>
        Connect Slack by pasting a bot token. The token is stored locally and never sent to any server.
        Create a bot at <strong>api.slack.com/apps</strong>, add it to your workspace, and copy the Bot User OAuth Token.
      </p>

      {status?.connected ? (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--green-500, #22c55e)', display: 'inline-block' }} />
            <span style={{ fontSize: 13, color: 'var(--slate-700)' }}>
              Connected{teamName ? ` to ${teamName}` : ''}{botName ? ` as ${botName}` : ''}
            </span>
          </div>
          <button className="btn btn-secondary" onClick={disconnect}>Disconnect</button>
        </div>
      ) : (
        <div>
          <div className="form-group">
            <label className="form-label">Bot Token</label>
            <input
              type="password"
              className="form-input"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="xoxb-…"
              style={{ fontFamily: 'monospace' }}
            />
          </div>
          {error && (
            <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>✕ {error}</div>
          )}
          <button
            className="btn btn-primary"
            disabled={validating || !token.trim()}
            onClick={connect}
          >
            {validating ? 'Validating…' : 'Connect Slack'}
          </button>
        </div>
      )}
    </div>
  );
}

function JiraSettings({ config, update }: { config: Config; update: (key: keyof Config, value: string) => void }) {
  const [status, setStatus] = useState<{ connected: boolean; info: any } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [projects, setProjects] = useState<{ key: string; name: string }[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    (window as any).inwiseAPI.jiraStatus?.().then((s: any) => {
      setStatus(s);
      if (s?.connected) loadProjects();
    });
  }, []);

  const loadProjects = async () => {
    const res = await (window as any).inwiseAPI.jiraGetProjects?.();
    if (res?.ok) setProjects(res.projects);
  };

  const handleConnect = async () => {
    if (!config.jiraClientId || !config.jiraClientSecret) {
      setError('Enter your Client ID and Secret first');
      return;
    }
    setConnecting(true);
    setError('');
    // Save credentials before connecting so the main process can read them
    await (window as any).inwiseAPI.setConfig({
      jiraClientId: config.jiraClientId,
      jiraClientSecret: config.jiraClientSecret,
    });
    const result = await (window as any).inwiseAPI.jiraConnect();
    if (result.ok) {
      const s = await (window as any).inwiseAPI.jiraStatus();
      setStatus(s);
      loadProjects();
    } else {
      setError(result.error || 'Connection failed');
    }
    setConnecting(false);
  };

  const handleDisconnect = async () => {
    await (window as any).inwiseAPI.jiraDisconnect();
    setStatus({ connected: false, info: null });
    setProjects([]);
  };

  return (
    <div>
      {!status?.connected ? (
        <>
          <p style={{ fontSize: 13, color: 'var(--slate-500)', marginBottom: 16, lineHeight: 1.6 }}>
            Register an OAuth app at{' '}
            <span style={{ color: 'var(--teal)', cursor: 'pointer' }}
              onClick={() => (window as any).inwiseAPI.openExternal('https://developer.atlassian.com/console/myapps/')}>
              developer.atlassian.com
            </span>
            {' '}with callback URL <code style={{ fontSize: 12, background: 'var(--slate-100)', padding: '2px 6px', borderRadius: 4 }}>http://localhost:17291/callback</code>,
            then paste your credentials below.
          </p>

          <div className="form-group" style={{ marginBottom: 12 }}>
            <label className="form-label">Client ID</label>
            <input type="text" className="form-input" value={config.jiraClientId}
              onChange={e => update('jiraClientId', e.target.value)} placeholder="e.g. 74pdU1t2..." />
          </div>

          <div className="form-group" style={{ marginBottom: 16 }}>
            <label className="form-label">Client Secret</label>
            <input type="password" className="form-input" value={config.jiraClientSecret}
              onChange={e => update('jiraClientSecret', e.target.value)} placeholder="Secret from your Atlassian app" />
          </div>

          {error && <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 12 }}>✕ {error}</div>}

          <button className="btn btn-primary btn-sm" onClick={handleConnect}
            disabled={connecting || !config.jiraClientId || !config.jiraClientSecret}>
            {connecting ? 'Connecting…' : 'Connect Jira'}
          </button>
        </>
      ) : (
        <>
          <div style={{ padding: '12px 16px', background: 'var(--slate-50)', borderRadius: 8, border: '1px solid var(--slate-200)', marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--navy)' }}>
                  {status.info?.cloudName || 'Jira Cloud'}
                </div>
                {status.info?.email && (
                  <div style={{ fontSize: 12, color: 'var(--slate-500)' }}>Connected as {status.info.email}</div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {status.info?.cloudUrl && (
                  <button className="btn btn-secondary btn-sm" style={{ fontSize: 11 }}
                    onClick={() => (window as any).inwiseAPI.openExternal(status.info.cloudUrl)}>
                    Open Jira
                  </button>
                )}
                <button className="btn btn-secondary btn-sm" style={{ fontSize: 11, color: 'var(--red)' }}
                  onClick={handleDisconnect}>
                  Disconnect
                </button>
              </div>
            </div>
          </div>

          <div className="form-group" style={{ marginBottom: 12 }}>
            <label className="form-label">Default Project</label>
            <select className="form-select" value={config.jiraDefaultProject}
              onChange={e => update('jiraDefaultProject', e.target.value)}>
              <option value="">Select a project</option>
              {projects.map(p => (
                <option key={p.key} value={p.key}>{p.name} ({p.key})</option>
              ))}
            </select>
            <span style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 4, display: 'block' }}>
              New tasks will be pushed to this project by default.
            </span>
          </div>

          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={config.jiraAutoPush as any === true || config.jiraAutoPush === 'true' as any}
                onChange={e => update('jiraAutoPush' as any, e.target.checked as any)} />
              <span className="form-label" style={{ margin: 0 }}>Auto-push tasks to your systems</span>
            </label>
            <span style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 4, display: 'block', paddingLeft: 24 }}>
              Tasks from meetings push to the right destination automatically.
            </span>
          </div>

          <ApprovalGateSettings />
        </>
      )}
    </div>
  );
}

// ── Approval gate settings (US-006) ─────────────────────────────────────────
// Self-managed slice: reads/writes `sor.jira` via api, independent of the
// parent Settings form's save-button lifecycle. Saves on change (debounced
// via React state + blur on slider) so the gate takes effect immediately
// the next time auto-push runs — no "save to apply" footgun.

function ApprovalGateSettings() {
  const [enabled, setEnabled] = useState(false);
  const [threshold, setThreshold] = useState(0.6);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await (window as any).inwiseAPI.getConfig();
        const jira = cfg?.sor?.jira ?? {};
        setEnabled(jira.approvalGateEnabled === true);
        const t = typeof jira.approvalThreshold === 'number' ? jira.approvalThreshold : 0.6;
        setThreshold(Math.max(0, Math.min(1, t)));
      } catch {
        /* best-effort — keep defaults */
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const persist = async (next: { approvalGateEnabled: boolean; approvalThreshold: number }) => {
    // Merge-in rather than overwrite so we don't clobber sor.dismissedReceiptIds.
    const cfg = await (window as any).inwiseAPI.getConfig();
    const existingSor = cfg?.sor ?? {};
    await (window as any).inwiseAPI.setConfig({
      sor: {
        ...existingSor,
        jira: {
          approvalGateEnabled: next.approvalGateEnabled,
          approvalThreshold: next.approvalThreshold,
        },
      },
    });
  };

  const toggle = async (value: boolean) => {
    setEnabled(value);
    await persist({ approvalGateEnabled: value, approvalThreshold: threshold });
  };

  const onThresholdChange = (value: number) => {
    const clamped = Math.max(0, Math.min(1, value));
    setThreshold(clamped);
  };

  const onThresholdCommit = async () => {
    await persist({ approvalGateEnabled: enabled, approvalThreshold: threshold });
  };

  if (!loaded) return null;

  const percent = Math.round(threshold * 100);

  return (
    <div className="form-group" style={{ marginTop: 12 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => toggle(e.target.checked)}
        />
        <span className="form-label" style={{ margin: 0 }}>Wait for my approval on weak matches</span>
      </label>
      <span style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 4, display: 'block', paddingLeft: 24, lineHeight: 1.5 }}>
        Anything below{' '}
        <input
          type="number"
          min={0}
          max={100}
          step={5}
          value={percent}
          disabled={!enabled}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onThresholdChange(Math.max(0, Math.min(100, v)) / 100);
          }}
          onBlur={onThresholdCommit}
          aria-label="Confidence threshold percent"
          style={{
            width: 48,
            padding: '1px 4px',
            margin: '0 2px',
            fontSize: 12,
            fontWeight: 600,
            textAlign: 'center',
            border: '1px solid var(--slate-300)',
            borderRadius: 4,
            background: enabled ? 'white' : 'var(--slate-50)',
            color: enabled ? 'var(--slate-700)' : 'var(--slate-400)',
          }}
        />% match confidence waits in your Inbox for approval.
      </span>
    </div>
  );
}

// ── Integrations status block (US-003) ──────────────────────────────────────

type SorOp = 'create' | 'update' | 'transition' | 'comment';
type SorResult = 'pending' | 'success' | 'failed' | 'pending-approval' | 'retrying';
type SorSystem = 'jira';

interface SorFieldDiff { field: string; before: any; after: any }
interface SorSpan { start: number; end: number; snippet: string }

interface SorWriteEntry {
  _id: string;
  targetSystem: SorSystem;
  targetRecordId: string;
  targetRecordUrl: string | null;
  operation: SorOp;
  fieldDiffs: SorFieldDiff[];
  commentBody: string | null;
  sourceMeetingId: string | null;
  sourceTranscriptSpan: SorSpan | null;
  linkedTaskId: string | null;
  confidence: number | null;
  approvalPath: 'auto' | 'user' | 'opt-in-gated';
  result: SorResult;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  retryCount: number;
}

interface IntegrationAggregate {
  system: SorSystem;
  total: number;
  success: number;
  failed: number;
  lastWriteAt: string | null;
}

const SOR_OP_LABEL: Record<SorOp, string> = {
  create: 'Created',
  update: 'Updated',
  transition: 'Transitioned',
  comment: 'Commented',
};

const SOR_OP_COLOR: Record<SorOp, string> = {
  create: '#0F766E',
  update: '#1D4ED8',
  transition: '#7C3AED',
  comment: '#475569',
};

function sorOneLineSummary(entry: SorWriteEntry): string {
  if (entry.operation === 'create') return 'New issue created';
  if (entry.operation === 'comment') return 'Comment added';
  if (entry.operation === 'transition') {
    const d = entry.fieldDiffs.find(x => x.field === 'status');
    if (d) return `Status: ${d.before ?? '—'} → ${d.after ?? '—'}`;
    return 'Status transition';
  }
  const n = entry.fieldDiffs.length;
  if (n === 0) return 'No field changes';
  if (n === 1) return `${entry.fieldDiffs[0].field} changed`;
  return `+${n} fields`;
}

function SorWriteRow({ entry, onRetry, retrying }: {
  entry: SorWriteEntry;
  onRetry: (id: string) => void;
  retrying: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const isFailed = entry.result === 'failed';
  const isPending = entry.result === 'pending' || entry.result === 'retrying' || entry.result === 'pending-approval';

  return (
    <div style={{
      padding: '10px 12px',
      border: '1px solid',
      borderColor: isFailed ? '#FECACA' : 'var(--slate-200)',
      borderRadius: 8,
      background: isFailed ? '#FEF2F2' : 'white',
      marginBottom: 6,
    }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <button
          onClick={() => setExpanded(e => !e)}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--slate-400)', fontSize: 12, padding: 0, marginTop: 2, width: 14, flexShrink: 0,
          }}
        >
          {expanded ? '▾' : '▸'}
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 2 }}>
            <span style={{
              fontSize: 10, fontWeight: 700, color: SOR_OP_COLOR[entry.operation],
              background: `${SOR_OP_COLOR[entry.operation]}1a`, borderRadius: 4, padding: '2px 6px',
              textTransform: 'uppercase', letterSpacing: '0.04em',
            }}>
              {SOR_OP_LABEL[entry.operation]}
            </span>
            {entry.targetRecordId && entry.targetRecordId !== '(pending-create)' && (
              <button
                style={{
                  background: 'none', border: 'none', cursor: entry.targetRecordUrl ? 'pointer' : 'default',
                  color: '#1a7080', fontSize: 12, fontWeight: 600, padding: 0,
                  textDecoration: entry.targetRecordUrl ? 'underline' : 'none',
                }}
                onClick={() => {
                  if (entry.targetRecordUrl) (window as any).inwiseAPI.openExternal(entry.targetRecordUrl);
                }}
                disabled={!entry.targetRecordUrl}
              >
                {entry.targetRecordId}
              </button>
            )}
            {isFailed && (
              <span style={{
                fontSize: 10, fontWeight: 700, color: '#DC2626',
                background: 'rgba(220, 38, 38, 0.1)', borderRadius: 4, padding: '2px 6px',
              }}>FAILED</span>
            )}
            {isPending && (
              <span style={{
                fontSize: 10, fontWeight: 700, color: '#B45309',
                background: 'rgba(180, 83, 9, 0.1)', borderRadius: 4, padding: '2px 6px',
              }}>
                {entry.result === 'pending-approval' ? 'PENDING APPROVAL' : 'IN PROGRESS'}
              </span>
            )}
            <span style={{ fontSize: 11, color: 'var(--slate-400)', marginLeft: 'auto' }}>
              {formatAgo(new Date(entry.createdAt).getTime())}
            </span>
          </div>

          <div style={{ fontSize: 13, color: 'var(--slate-700)', lineHeight: 1.4 }}>
            {sorOneLineSummary(entry)}
          </div>

          {isFailed && entry.errorMessage && !expanded && (
            <div style={{ fontSize: 11, color: '#991B1B', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {entry.errorMessage}
            </div>
          )}

          {expanded && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--slate-100)' }}>
              {entry.operation === 'comment' && entry.commentBody && (
                <div style={{
                  background: 'var(--slate-50)', borderRadius: 6, padding: 8,
                  fontSize: 12, color: 'var(--slate-700)', whiteSpace: 'pre-wrap',
                }}>
                  {entry.commentBody}
                </div>
              )}

              {entry.operation !== 'comment' && entry.fieldDiffs.length > 0 && (
                <div style={{ fontSize: 12 }}>
                  <div style={{
                    fontSize: 10, fontWeight: 600, color: 'var(--slate-400)',
                    textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4,
                  }}>
                    Field changes
                  </div>
                  {entry.fieldDiffs.map((d, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 2 }}>
                      <span style={{ color: 'var(--slate-500)', minWidth: 80, fontWeight: 500 }}>{d.field}</span>
                      <span style={{
                        color: 'var(--slate-500)',
                        textDecoration: entry.operation === 'create' ? 'none' : 'line-through',
                      }}>
                        {d.before === null || d.before === undefined ? '—' : String(d.before)}
                      </span>
                      <span style={{ color: 'var(--slate-400)' }}>→</span>
                      <span style={{ color: 'var(--slate-800)' }}>
                        {d.after === null || d.after === undefined ? '—' : String(d.after)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {entry.sourceTranscriptSpan?.snippet && (
                <div style={{ marginTop: 8 }}>
                  <div style={{
                    fontSize: 10, fontWeight: 600, color: 'var(--slate-400)',
                    textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4,
                  }}>From transcript</div>
                  <div style={{
                    borderLeft: '3px solid #9dd4d9', background: '#f0fafa',
                    padding: '6px 10px', borderRadius: '0 6px 6px 0',
                    fontSize: 12, color: 'var(--slate-700)', fontStyle: 'italic',
                  }}>
                    "{entry.sourceTranscriptSpan.snippet}"
                  </div>
                </div>
              )}

              {isFailed && entry.errorMessage && (
                <div style={{
                  marginTop: 8, padding: 8, borderRadius: 6,
                  background: '#FEF2F2', border: '1px solid #FECACA',
                  fontSize: 12, color: '#991B1B',
                }}>
                  {entry.errorMessage}
                </div>
              )}
            </div>
          )}
        </div>

        {isFailed && (
          <button
            className="btn btn-secondary btn-sm"
            style={{ fontSize: 11, padding: '2px 8px', color: '#DC2626', flexShrink: 0 }}
            onClick={() => onRetry(entry._id)}
            disabled={retrying}
          >
            {retrying ? '…' : '↻ Retry'}
          </button>
        )}
      </div>
    </div>
  );
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function IntegrationsSection() {
  const [jiraStatus, setJiraStatus] = useState<{ connected: boolean; info: any } | null>(null);
  const [aggregates, setAggregates] = useState<IntegrationAggregate[]>([]);
  const [recentByIntegration, setRecentByIntegration] = useState<Record<SorSystem, SorWriteEntry[]>>({ jira: [] });
  const [failedCount, setFailedCount] = useState<Record<SorSystem, number>>({ jira: 0 });
  const [expanded, setExpanded] = useState<Record<SorSystem, boolean>>({ jira: false });
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [bulkRetrying, setBulkRetrying] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);

  const sinceMs = useMemoSince();

  const reload = async () => {
    const win = window as any;
    try {
      const [status, agg, recent, failed] = await Promise.all([
        win.inwiseAPI.jiraStatus?.().catch(() => null),
        win.inwiseAPI.sorAggregateByIntegration(sinceMs).catch(() => []),
        win.inwiseAPI.sorListRecent(10, sinceMs).catch(() => []),
        win.inwiseAPI.sorListFailed('jira', sinceMs).catch(() => []),
      ]);
      setJiraStatus(status);
      setAggregates(Array.isArray(agg) ? agg : []);
      const recentRows: SorWriteEntry[] = Array.isArray(recent) ? recent : [];
      setRecentByIntegration({ jira: recentRows.filter(r => r.targetSystem === 'jira') });
      setFailedCount({ jira: Array.isArray(failed) ? failed.length : 0 });
    } catch {
      /* best-effort — leave prior state */
    }
  };

  useEffect(() => {
    reload();
    const win = window as any;
    const handler = () => { reload(); };
    win.inwiseAPI.on?.('sor:write-completed', handler);
    return () => win.inwiseAPI.off?.('sor:write-completed', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRetryOne = async (id: string) => {
    setRetryingId(id);
    try {
      await (window as any).inwiseAPI.sorRetry(id);
    } finally {
      setRetryingId(null);
      // live-refresh IPC will trigger reload, but kick one just in case
      reload();
    }
  };

  const handleRetryFailed = async () => {
    setBulkRetrying(true);
    setBulkResult(null);
    try {
      const res = await (window as any).inwiseAPI.sorRetryFailed('jira', sinceMs);
      if (res?.ok) {
        const parts: string[] = [];
        if (res.succeeded > 0) parts.push(`${res.succeeded} succeeded`);
        if (res.failed > 0) parts.push(`${res.failed} still failing`);
        setBulkResult(parts.length > 0 ? parts.join(', ') : 'No changes');
      } else {
        setBulkResult(res?.error || 'Retry failed');
      }
    } catch (e: any) {
      setBulkResult(e?.message || 'Retry failed');
    } finally {
      setBulkRetrying(false);
      reload();
      setTimeout(() => setBulkResult(null), 4000);
    }
  };

  const handleDisconnectJira = async () => {
    if (!window.confirm('Disconnect Jira? Auto-push will stop until you reconnect.')) return;
    await (window as any).inwiseAPI.jiraDisconnect();
    reload();
  };

  const jiraAgg = aggregates.find(a => a.system === 'jira') ?? {
    system: 'jira' as SorSystem, total: 0, success: 0, failed: 0, lastWriteAt: null,
  };

  const connectionPill = (() => {
    if (!jiraStatus?.connected) {
      return { label: 'Disconnected', bg: 'var(--slate-100)', color: 'var(--slate-500)' };
    }
    const authExpired = jiraStatus.info?.authExpired === true;
    if (authExpired) return { label: 'Auth expired', bg: '#FEF3C7', color: '#92400E' };
    return { label: 'Connected', bg: 'rgba(13, 148, 136, 0.1)', color: 'var(--teal)' };
  })();

  const countsLine = (() => {
    if (jiraAgg.total === 0) return 'No writes yet.';
    const parts: string[] = [];
    parts.push(`${jiraAgg.success} write${jiraAgg.success !== 1 ? 's' : ''}`);
    if (jiraAgg.failed > 0) parts.push(`${jiraAgg.failed} failed`);
    if (jiraAgg.lastWriteAt) parts.push(`last write ${formatAgo(new Date(jiraAgg.lastWriteAt).getTime())}`);
    return parts.join(' · ');
  })();

  const jiraRecent = recentByIntegration.jira;
  const jiraFailedN = failedCount.jira;

  return (
    <div className="settings-section">
      <div className="settings-section-title">Integrations</div>
      <p style={{ fontSize: 13, color: 'var(--slate-500)', marginBottom: 14, lineHeight: 1.6 }}>
        Status and recent sync activity for every connected system of record. Last 30 days.
      </p>

      {/* Jira card */}
      <div style={{
        border: '1px solid var(--slate-200)', borderRadius: 10, padding: 14, background: 'white',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--navy)' }}>Jira</span>
          <span style={{
            fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
            background: connectionPill.bg, color: connectionPill.color,
          }}>
            {connectionPill.label}
          </span>
        </div>

        <div style={{ fontSize: 13, color: 'var(--slate-600)', marginBottom: 10 }}>
          {countsLine}
        </div>

        {/* Action row */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <button
            className="btn btn-secondary btn-sm"
            style={{ fontSize: 12 }}
            onClick={handleRetryFailed}
            disabled={jiraFailedN === 0 || bulkRetrying || !jiraStatus?.connected}
          >
            {bulkRetrying ? 'Retrying…' : `Retry failed${jiraFailedN > 0 ? ` (${jiraFailedN})` : ''}`}
          </button>
          {jiraStatus?.connected && (
            <button
              className="btn btn-secondary btn-sm"
              style={{ fontSize: 12, color: 'var(--red)' }}
              onClick={handleDisconnectJira}
            >
              Disconnect
            </button>
          )}
          {bulkResult && (
            <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>{bulkResult}</span>
          )}
        </div>

        {/* Recent activity, collapsible */}
        {jiraRecent.length > 0 ? (
          <div>
            <button
              onClick={() => setExpanded(e => ({ ...e, jira: !e.jira }))}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 12, fontWeight: 600, color: 'var(--slate-600)',
                padding: 0, display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              <span>{expanded.jira ? '▾' : '▸'}</span>
              <span>Recent activity ({jiraRecent.length})</span>
            </button>
            {expanded.jira && (
              <div style={{ marginTop: 10 }}>
                {jiraRecent.map(entry => (
                  <SorWriteRow
                    key={entry._id}
                    entry={entry}
                    onRetry={handleRetryOne}
                    retrying={retryingId === entry._id}
                  />
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function useMemoSince(): number {
  // Stable for the lifetime of this component instance. Small drift across days is fine
  // for a Settings page that the user is typically viewing for a short session.
  const ref = useRef<number | null>(null);
  if (ref.current === null) ref.current = Date.now() - THIRTY_DAYS_MS;
  return ref.current;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function SelfEmailsEditor({ emails, onChange }: { emails: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
  }, []);

  const flashError = (msg: string) => {
    setError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setError(null), 3000);
  };

  const tryAdd = (raw: string) => {
    const candidate = raw.trim();
    if (!candidate) return false;
    if (!EMAIL_RE.test(candidate)) {
      flashError(`"${candidate}" is not a valid email address`);
      return false;
    }
    const lower = candidate.toLowerCase();
    if (emails.some(e => e.toLowerCase() === lower)) {
      return false;
    }
    onChange([...emails, candidate]);
    return true;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (tryAdd(draft)) {
        setDraft('');
      }
    } else if (e.key === 'Backspace' && draft === '' && emails.length > 0) {
      onChange(emails.slice(0, -1));
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value.endsWith(',')) {
      if (tryAdd(value.slice(0, -1))) {
        setDraft('');
      } else {
        setDraft(value.slice(0, -1));
      }
    } else {
      setDraft(value);
    }
  };

  const handleBlur = () => {
    if (draft.trim()) {
      if (tryAdd(draft)) {
        setDraft('');
      }
    }
  };

  const removeAt = (idx: number) => {
    onChange(emails.filter((_, i) => i !== idx));
  };

  return (
    <div className="form-group" style={{ marginBottom: 16 }}>
      <label className="form-label">Your email addresses</label>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          padding: '6px 8px',
          border: '1px solid var(--slate-300)',
          borderRadius: 6,
          background: 'var(--white, #fff)',
          minHeight: 38,
          alignItems: 'center',
        }}
      >
        {emails.map((email, idx) => (
          <span
            key={`${email}-${idx}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '3px 4px 3px 10px',
              background: 'var(--slate-100)',
              border: '1px solid var(--slate-200)',
              borderRadius: 999,
              fontSize: 12,
              color: 'var(--slate-700)',
            }}
          >
            {email}
            <button
              type="button"
              aria-label={`Remove ${email}`}
              onClick={() => removeAt(idx)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 18,
                height: 18,
                borderRadius: '50%',
                border: 'none',
                background: 'transparent',
                color: 'var(--slate-500)',
                cursor: 'pointer',
                fontSize: 14,
                lineHeight: 1,
                padding: 0,
              }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          value={draft}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={emails.length === 0 ? 'you@example.com' : ''}
          style={{
            flex: 1,
            minWidth: 140,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontSize: 13,
            padding: '4px 2px',
            color: 'var(--slate-800)',
          }}
        />
      </div>
      {error && (
        <span style={{ fontSize: 12, color: 'var(--red, #d33)', marginTop: 4, display: 'block' }}>
          {error}
        </span>
      )}
      <span style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 4, display: 'block' }}>
        Separate from display name. Used to identify you in attendee lists across multiple calendars.
      </span>
    </div>
  );
}

function VoiceEnrollment() {
  const [prints, setPrints] = useState<VoicePrintInfo[]>([]);
  const [enrolling, setEnrolling] = useState(false);
  const [enrollName, setEnrollName] = useState('');
  const [isUserEnroll, setIsUserEnroll] = useState(false);
  const [recStatus, setRecStatus] = useState<'idle' | 'recording' | 'saving' | 'done' | 'error'>('idle');
  const [level, setLevel] = useState(0);
  const [countdown, setCountdown] = useState(10);
  const [errMsg, setErrMsg] = useState('');
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playError, setPlayError] = useState<Record<string, string>>({});
  const [missingAudio, setMissingAudio] = useState<Record<string, boolean>>({});
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const blobUrlCacheRef = useRef<Map<string, string>>(new Map());
  const playErrorTimersRef = useRef<Map<string, number>>(new Map());

  const showPlayError = (id: string, message: string) => {
    setPlayError(prev => ({ ...prev, [id]: message }));
    const existing = playErrorTimersRef.current.get(id);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      setPlayError(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      playErrorTimersRef.current.delete(id);
    }, 3000);
    playErrorTimersRef.current.set(id, timer);
  };

  const fetchBlobUrl = async (id: string): Promise<string | null> => {
    const cache = blobUrlCacheRef.current;
    const cached = cache.get(id);
    if (cached) return cached;
    try {
      const result = await (window as any).inwiseAPI.getVoicePrintAudio(id);
      if (!result?.audioClip) {
        setMissingAudio(prev => ({ ...prev, [id]: true }));
        return null;
      }
      // IPC may deliver Uint8Array as a plain object — normalize
      const raw = result.audioClip;
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(Object.values(raw) as number[]);
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      cache.set(id, url);
      return url;
    } catch (err: any) {
      showPlayError(id, err?.message || 'Failed to load audio.');
      return null;
    }
  };

  const startPlayback = (id: string, url: string) => {
    const audio = new Audio(url);
    audioRef.current = audio;
    setPlayingId(id);
    const clearIfMine = () => {
      if (audioRef.current === audio) audioRef.current = null;
      setPlayingId(curr => (curr === id ? null : curr));
    };
    audio.onended = clearIfMine;
    audio.onerror = () => {
      clearIfMine();
      showPlayError(id, `MediaError: ${audio.error?.code ?? 'unknown'}`);
    };
    const playPromise = audio.play();
    if (playPromise && typeof (playPromise as Promise<void>).catch === 'function') {
      (playPromise as Promise<void>).catch((err: any) => {
        clearIfMine();
        const label = err?.name
          ? `${err.name}: ${err.message || 'playback rejected'}`
          : (err?.message || 'Playback failed.');
        showPlayError(id, label);
      });
    }
  };

  const playAudio = (id: string) => {
    // Stop current playback if any
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (playingId === id) {
      setPlayingId(null);
      return;
    }
    if (missingAudio[id]) return;
    // Use cached blob URL to keep audio.play() synchronous on the user-gesture chain.
    const cachedUrl = blobUrlCacheRef.current.get(id);
    if (cachedUrl) {
      startPlayback(id, cachedUrl);
      return;
    }
    // Cache miss (prefetch pending or previously failed) — fetch then play.
    void fetchBlobUrl(id).then(url => {
      if (url) startPlayback(id, url);
    });
  };

  const loadPrints = async () => {
    const list: VoicePrintInfo[] = await (window as any).inwiseAPI.getVoicePrints();
    setPrints(list.sort((a, b) => (b.isUser ? 1 : 0) - (a.isUser ? 1 : 0)));
    // Prefetch blob URLs so clicking Play stays on the user-gesture chain (Chromium).
    list.filter(p => p.hasAudio).forEach(p => { void fetchBlobUrl(p._id); });
  };

  useEffect(() => { loadPrints(); }, []);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
      for (const url of blobUrlCacheRef.current.values()) URL.revokeObjectURL(url);
      blobUrlCacheRef.current.clear();
      for (const timer of playErrorTimersRef.current.values()) window.clearTimeout(timer);
      playErrorTimersRef.current.clear();
    };
  }, []);

  const startEnroll = (asUser: boolean) => {
    setEnrolling(true);
    setIsUserEnroll(asUser);
    setEnrollName(asUser ? (prints.find(p => p.isUser)?.name || '') : '');
    setRecStatus('idle');
    setErrMsg('');
  };

  const cancelEnroll = () => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setEnrolling(false);
    setRecStatus('idle');
  };

  const record = async () => {
    if (!enrollName.trim()) return;
    setRecStatus('recording');
    setLevel(0);
    setCountdown(10);
    setErrMsg('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setLevel(Math.min(100, (avg / 128) * 100));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();

      let remaining = 10;
      const countdownId = setInterval(() => { remaining--; setCountdown(remaining); }, 1000);

      const chunks: Blob[] = [];
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      mr.start(250);

      setTimeout(async () => {
        clearInterval(countdownId);
        cancelAnimationFrame(rafRef.current);
        mr.stop();
        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        setLevel(0);
        setRecStatus('saving');

        await new Promise<void>(resolve => { mr.onstop = () => resolve(); });

        const blob = new Blob(chunks, { type: 'audio/webm' });
        const arrayBuffer = await blob.arrayBuffer();
        const audioCtx = new AudioContext({ sampleRate: 16000 });
        const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
        audioCtx.close();
        ctx.close();

        const pcm = decoded.getChannelData(0);
        const samples = new Int16Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) {
          samples[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
        }
        const dataLength = samples.length * 2;
        const wav = new ArrayBuffer(44 + dataLength);
        const view = new DataView(wav);
        const w = (off: number, str: string) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
        w(0, 'RIFF'); view.setUint32(4, 36 + dataLength, true);
        w(8, 'WAVE'); w(12, 'fmt '); view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
        view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        w(36, 'data'); view.setUint32(40, dataLength, true);
        new Int16Array(wav, 44).set(samples);

        try {
          const result = await (window as any).inwiseAPI.saveVoicePrint({
            name: enrollName.trim(),
            audioClip: new Uint8Array(wav),
            isUser: isUserEnroll,
          });
          if (result.ok) {
            setRecStatus('done');
            await loadPrints();
            setTimeout(() => { setEnrolling(false); setRecStatus('idle'); }, 1500);
          } else {
            setErrMsg(result.error || 'Save failed');
            setRecStatus('error');
          }
        } catch (e: any) {
          setErrMsg(e.message);
          setRecStatus('error');
        }
      }, 10000);
    } catch (e: any) {
      setErrMsg(e.message || 'Could not access microphone');
      setRecStatus('error');
    }
  };

  const deletePrint = async (id: string) => {
    await (window as any).inwiseAPI.deleteVoicePrint(id);
    await loadPrints();
  };

  const userPrint = prints.find(p => p.isUser);

  return (
    <div>
      {/* Enrolled voices list */}
      {prints.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          {prints.map(p => (
            <div key={p._id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 12px', background: 'var(--slate-100)', borderRadius: 8, marginBottom: 6,
            }}>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--navy)' }}>{p.name}</span>
                {p.isUser && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, color: 'var(--teal)',
                    background: 'rgba(13, 148, 136, 0.1)', borderRadius: 4, padding: '2px 6px', marginLeft: 8,
                  }}>YOU</span>
                )}
                {p.name.startsWith('Unidentified') && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, color: 'var(--slate-400)',
                    background: 'var(--slate-200)', borderRadius: 4, padding: '2px 6px', marginLeft: 8,
                  }}>PENDING</span>
                )}
              </div>
              <span style={{ fontSize: 11, color: 'var(--slate-400)' }}>
                {new Date(p.createdAt).toLocaleDateString()}
              </span>
              {p.hasAudio && (
                <>
                  <button
                    disabled={!!missingAudio[p._id]}
                    style={{
                      background: playingId === p._id ? 'rgba(13, 148, 136, 0.15)' : 'none',
                      border: '1px solid',
                      borderColor: playingId === p._id ? 'var(--teal)' : 'var(--slate-300)',
                      borderRadius: 6,
                      cursor: missingAudio[p._id] ? 'not-allowed' : 'pointer',
                      color: missingAudio[p._id]
                        ? 'var(--slate-400)'
                        : (playingId === p._id ? 'var(--teal)' : 'var(--slate-500)'),
                      fontSize: 12, padding: '2px 8px', display: 'flex', alignItems: 'center', gap: 4,
                      opacity: missingAudio[p._id] ? 0.6 : 1,
                    }}
                    onClick={() => playAudio(p._id)}
                    title={
                      missingAudio[p._id]
                        ? 'No audio clip stored for this voiceprint'
                        : (playingId === p._id ? 'Stop playback' : 'Play voice sample')
                    }
                  >
                    {missingAudio[p._id]
                      ? '(no audio)'
                      : (playingId === p._id ? '⏹ Stop' : '▶ Play')}
                  </button>
                  {playError[p._id] && (
                    <span
                      style={{
                        fontSize: 11, color: 'var(--red)',
                        maxWidth: 180, overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                      title={playError[p._id]}
                    >
                      {playError[p._id]}
                    </span>
                  )}
                </>
              )}
              {p.isUser ? (
                <button className="btn btn-secondary btn-sm" style={{ fontSize: 11, padding: '2px 8px' }}
                  onClick={() => startEnroll(true)}>
                  Re-record
                </button>
              ) : (
                <button style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--slate-400)', fontSize: 14, padding: '2px 6px',
                }} onClick={() => deletePrint(p._id)} title="Delete voice print">
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Enroll buttons */}
      {!enrolling && (
        <div style={{ display: 'flex', gap: 8 }}>
          {!userPrint && (
            <button className="btn btn-secondary btn-sm" onClick={() => startEnroll(true)}>
              Enroll Your Voice
            </button>
          )}
          <button className="btn btn-secondary btn-sm" onClick={() => startEnroll(false)}>
            Enroll Other Voice
          </button>
        </div>
      )}

      {/* Enrollment form */}
      {enrolling && (
        <div style={{ padding: '12px 16px', background: 'var(--slate-50)', borderRadius: 8, border: '1px solid var(--slate-200)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--navy)' }}>
              {isUserEnroll ? 'Record Your Voice' : 'Record a Voice'}
            </span>
            <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--slate-400)', fontSize: 16 }}
              onClick={cancelEnroll}>✕</button>
          </div>

          <div className="form-group" style={{ marginBottom: 12 }}>
            <input type="text" className="form-input" value={enrollName}
              onChange={e => setEnrollName(e.target.value)}
              placeholder={isUserEnroll ? 'Your name' : "Person's name"}
              disabled={recStatus === 'recording' || recStatus === 'saving'} />
          </div>

          {recStatus === 'idle' && (
            <button className="btn btn-secondary btn-sm" onClick={record} disabled={!enrollName.trim()}>
              Record 10 seconds
            </button>
          )}

          {recStatus === 'recording' && (
            <div>
              <div style={{ fontSize: 12, color: 'var(--slate-500)', marginBottom: 6 }}>
                {isUserEnroll ? 'Speak naturally' : `Have ${enrollName.trim() || 'them'} speak`} — {countdown}s remaining
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, height: 8, background: 'var(--slate-200)', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ width: `${level}%`, height: '100%', background: 'var(--teal)', borderRadius: 4, transition: 'width 0.05s' }} />
                </div>
                <span style={{ fontSize: 12, color: 'var(--slate-500)', fontVariantNumeric: 'tabular-nums' }}>{countdown}s</span>
              </div>
            </div>
          )}

          {recStatus === 'saving' && (
            <div style={{ fontSize: 12, color: 'var(--slate-500)' }}>Saving…</div>
          )}

          {recStatus === 'done' && (
            <div style={{ fontSize: 13, color: 'var(--teal)' }}>✓ Enrolled "{enrollName.trim()}"</div>
          )}

          {recStatus === 'error' && (
            <div>
              <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 6 }}>✕ {errMsg}</div>
              <button className="btn btn-secondary btn-sm" onClick={() => setRecStatus('idle')}>Try Again</button>
            </div>
          )}
        </div>
      )}

      <div style={{ fontSize: 12, color: 'var(--slate-400)', marginTop: 12, lineHeight: 1.5 }}>
        Voices from 1:1 meetings are enrolled automatically using your calendar attendee list.
        Group call voices are enrolled by elimination when possible.
      </div>
    </div>
  );
}

export default function Settings() {
  const [config, setConfig] = useState<Config | null>(null);
  const [saved, setSaved] = useState(false);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    (window as any).inwiseAPI.getConfig().then(setConfig);
    navigator.mediaDevices.enumerateDevices().then(devices => {
      setMics(devices.filter(d => d.kind === 'audioinput'));
    });
  }, []);

  if (!config) return null;

  const update = (key: keyof Config, value: string) => {
    setConfig(c => c ? { ...c, [key]: value } : c);
    setSaved(false);
  };

  const save = async () => {
    await (window as any).inwiseAPI.setConfig(config);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <>
      <div className="page-header">
        <div className="page-title">Settings</div>
        <div className="page-subtitle">Configure your AI provider, transcription model, and calendar</div>
      </div>
      <div className="page-body">
        <div className="settings-sections">

          {/* AI Provider */}
          <div className="settings-section">
            <div className="settings-section-title">AI Provider</div>

            <div className="form-group">
              <label className="form-label">Provider</label>
              <select
                className="form-select"
                value={config.apiProvider}
                onChange={e => update('apiProvider', e.target.value)}
              >
                <option value="anthropic">Anthropic (Claude Haiku)</option>
                <option value="openai">OpenAI (GPT-4o mini)</option>
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">
                {config.apiProvider === 'anthropic' ? 'Anthropic API Key' : 'OpenAI API Key'}
              </label>
              <input
                type="password"
                className="form-input"
                value={config.apiKey}
                onChange={e => update('apiKey', e.target.value)}
                placeholder={config.apiProvider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
              />
            </div>
          </div>

          {/* Transcription */}
          <div className="settings-section">
            <div className="settings-section-title">Transcription</div>
            <div className="form-group">
              <label className="form-label">Microphone</label>
              <select
                className="form-select"
                value={config.micDeviceId}
                onChange={e => update('micDeviceId', e.target.value)}
              >
                <option value="default">System Default</option>
                {mics.map(mic => (
                  <option key={mic.deviceId} value={mic.deviceId}>
                    {mic.label || `Microphone ${mic.deviceId.slice(0, 8)}`}
                  </option>
                ))}
              </select>
              <MicTest deviceId={config.micDeviceId} />
            </div>
            <div className="form-group">
              <label className="form-label">System Audio</label>
              <span style={{ fontSize: 12, color: 'var(--slate-500)', marginBottom: 4, display: 'block' }}>
                Captures audio playing through your speakers (e.g. the other person on a call).
                Play a video or music, then click test.
              </span>
              <SystemAudioTest />
            </div>
            <div className="form-group">
              <label className="form-label">Whisper Model</label>
              <select
                className="form-select"
                value={config.whisperModel}
                onChange={e => update('whisperModel', e.target.value)}
              >
                <option value="tiny">Tiny (~75 MB) — fastest</option>
                <option value="base">Base (~148 MB) — recommended</option>
                <option value="small">Small (~488 MB) — better accuracy</option>
                <option value="medium">Medium (~1.5 GB) — best accuracy</option>
              </select>
              <span style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 4 }}>
                Downloaded automatically on first use. Runs 100% locally — no audio ever leaves your device.
              </span>
            </div>
          </div>

          {/* Calendar */}
          <div className="settings-section">
            <div className="settings-section-title">Calendar</div>
            <p style={{ fontSize: 13, color: 'var(--slate-500)', marginBottom: 20, lineHeight: 1.6 }}>
              Inwise uses your calendar's private ICS link to detect upcoming meetings.
              No login or app registration required — just a URL you copy in about 30 seconds.
              The link is only used locally on your machine.
            </p>

            <CalendarStatus />

            <CalendarList />
          </div>

          {/* Jira */}
          <div className="settings-section">
            <div className="settings-section-title">Jira Integration</div>
            <JiraSettings config={config} update={update} />
          </div>

          {/* Slack */}
          <div className="settings-section">
            <div className="settings-section-title">Slack Integration</div>
            <SlackSettings />
          </div>

          {/* Integrations (US-003) */}
          <IntegrationsSection />

          {/* Voice Enrollment */}
          <div className="settings-section">
            <div className="settings-section-title">Voice Enrollment</div>
            <p style={{ fontSize: 13, color: 'var(--slate-500)', marginBottom: 16, lineHeight: 1.6 }}>
              Enrolled voices let Inwise identify who's speaking in your recordings.
            </p>

            <div className="form-group" style={{ marginBottom: 16 }}>
              <label className="form-label">Your Name</label>
              <input
                type="text"
                className="form-input"
                value={config.userName}
                onChange={e => update('userName', e.target.value)}
                placeholder="e.g. Shravya"
              />
              <span style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 4, display: 'block' }}>
                Used to label your voice in transcripts (left/mic channel).
              </span>
            </div>

            <SelfEmailsEditor
              emails={config.selfEmails ?? []}
              onChange={async (next) => {
                setConfig(c => c ? { ...c, selfEmails: next } : c);
                setSaved(false);
                await (window as any).inwiseAPI.setSelfEmails(next);
              }}
            />

            <VoiceEnrollment />
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="btn btn-primary" onClick={save}>Save Settings</button>
            {saved && <span style={{ fontSize: 13, color: 'var(--teal)' }}>✓ Saved</span>}
          </div>

          {/* Data Management */}
          <div className="settings-section" style={{ marginTop: 32, borderTop: '1px solid var(--slate-200)', paddingTop: 24 }}>
            <div className="settings-section-title">Data Management</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button className="btn btn-secondary btn-sm" onClick={async () => {
                try {
                  const result = await (window as any).inwiseAPI.seedDemoData();
                  if (result.seeded) {
                    alert(`Demo data loaded: ${result.meetings} meetings, ${result.tasks} tasks, ${result.people} people`);
                    window.location.reload();
                  } else {
                    alert(result.reason === 'already_exists' ? 'Demo data already loaded.' : 'Could not load demo data.');
                  }
                } catch (e: any) {
                  alert('Failed: ' + e.message);
                }
              }}>
                Load Demo Data
              </button>
              <button className="btn btn-secondary btn-sm" style={{ color: 'var(--slate-400)' }} onClick={async () => {
                if (!window.confirm('Remove all demo data? This will delete sample meetings, tasks, and people. Your real data will not be affected.')) return;
                try {
                  await (window as any).inwiseAPI.clearDemoData();
                  window.location.reload();
                } catch (e: any) {
                  alert('Failed to clear demo data: ' + e.message);
                }
              }}>
                Clear Demo Data
              </button>
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
