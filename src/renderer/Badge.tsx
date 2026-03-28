import React, { useState, useEffect, useRef } from 'react';

type Status = 'recording' | 'processing' | 'done' | 'error';

interface State {
  status: Status;
  message?: string;
  title: string;
}

const BAR_COUNT = 12;

const styles: Record<string, any> = {
  wrap: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    WebkitAppRegion: 'drag',
  },
  badge: {
    background: 'rgba(15, 23, 42, 0.97)',
    borderRadius: 16,
    padding: '0 20px',
    height: 56,
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
    userSelect: 'none',
    WebkitAppRegion: 'drag',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: '#ef4444',
    flexShrink: 0,
  },
  label: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    maxWidth: 140,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
  waveform: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    height: 24,
  },
  stopBtn: {
    width: 28,
    height: 28,
    borderRadius: '50%',
    background: '#ef4444',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    WebkitAppRegion: 'no-drag',
  },
};

function Waveform({ active }: { active: boolean }) {
  const [heights, setHeights] = useState<number[]>(() => Array(BAR_COUNT).fill(6));

  useEffect(() => {
    if (!active) { setHeights(Array(BAR_COUNT).fill(6)); return; }
    const id = setInterval(() => {
      setHeights(Array.from({ length: BAR_COUNT }, () => 4 + Math.random() * 18));
    }, 120);
    return () => clearInterval(id);
  }, [active]);

  return (
    <div style={styles.waveform}>
      {heights.map((h, i) => (
        <div
          key={i}
          style={{
            width: 3,
            height: h,
            borderRadius: 2,
            background: `linear-gradient(to top, #0d9488, #14b8a6)`,
            transition: 'height 0.1s ease',
          }}
        />
      ))}
    </div>
  );
}

export default function Badge() {
  const [state, setState] = useState<State>({ status: 'recording', title: 'Meeting' });
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    (window as any).inwiseAPI.on('recording:start', (title: string) => {
      setState({ status: 'recording', title });
      startRef.current = Date.now();
      startMic(title);
    });

    (window as any).inwiseAPI.on('recording:status', ({ status, message }: { status: Status; message?: string }) => {
      setState((s) => ({ ...s, status, message }));
    });
  }, []);

  useEffect(() => {
    if (state.status !== 'recording') return;
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  const startMic = async (title: string) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      mediaRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.start(250);
    } catch (e: any) {
      setState((s) => ({ ...s, status: 'error', message: `Microphone error: ${e.message}` }));
    }
  };

  const stopRecording = async () => {
    const mr = mediaRef.current;
    if (!mr) return;
    mr.stop();
    mr.stream.getTracks().forEach(t => t.stop());

    await new Promise<void>(resolve => { mr.onstop = () => resolve(); });

    const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
    const arrayBuffer = await blob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    (window as any).electronAPI?.sendAudio({
      buffer,
      title: state.title,
    });
  };

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  if (state.status === 'done') {
    return (
      <div style={styles.wrap}>
        <div style={{ ...styles.badge, gap: 10 }}>
          <span style={{ fontSize: 18 }}>✓</span>
          <span style={{ ...styles.label, color: '#14b8a6' }}>Meeting saved</span>
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div style={styles.wrap}>
        <div style={{ ...styles.badge, gap: 10 }}>
          <span style={{ fontSize: 16 }}>⚠</span>
          <span style={{ ...styles.label, color: '#fca5a5', maxWidth: 200 }}>{state.message || 'Error'}</span>
        </div>
      </div>
    );
  }

  if (state.status === 'processing') {
    return (
      <div style={styles.wrap}>
        <div style={{ ...styles.badge, gap: 10 }}>
          <span style={{ ...styles.dot, background: '#f59e0b', animation: 'pulse 1s infinite' }} />
          <span style={styles.label}>{state.message || 'Processing…'}</span>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.badge}>
        <div style={{ ...styles.dot, animation: 'pulse 1s infinite' }} />
        <span style={styles.label}>{state.title}</span>
        <Waveform active />
        <span style={{ color: '#94a3b8', fontSize: 13, fontFamily: 'monospace', minWidth: 42 }}>{fmt(elapsed)}</span>
        <button style={styles.stopBtn} onClick={stopRecording} title="Stop recording">
          <div style={{ width: 10, height: 10, background: 'white', borderRadius: 2 }} />
        </button>
      </div>
    </div>
  );
}
