import React, { useState, useEffect, useRef } from 'react';

type Status = 'recording' | 'processing' | 'done' | 'error' | 'received';

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
  const [sysAudioWarning, setSysAudioWarning] = useState(false);
  const startRef = useRef(Date.now());
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const hasStereoRef = useRef(false);
  const stopRecordingRef = useRef<() => void>(() => {});
  const titleRef = useRef<string>('Meeting');
  const calendarEventIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    (window as any).inwiseAPI.on('recording:start', (title: string, calendarEventId?: string) => {
      titleRef.current = title;
      calendarEventIdRef.current = calendarEventId;
      setState({ status: 'recording', title });
      startRef.current = Date.now();
      startMic(title);
    });

    (window as any).inwiseAPI.on('recording:status', ({ status, message }: { status: Status; message?: string }) => {
      setState((s) => ({ ...s, status, message }));
    });

    (window as any).inwiseAPI.on('recording:stop-request', () => {
      stopRecordingRef.current();
    });
  }, []);

  useEffect(() => {
    if (state.status !== 'recording') return;
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  const startMic = async (title: string) => {
    const reportHealth = (h: { micOk: boolean; systemAudioOk: boolean; message?: string }) => {
      try { (window as any).electronAPI?.sendAudioHealth(h); } catch { /* ignore */ }
    };
    try {
      const cfg = await (window as any).inwiseAPI.getConfig();
      const deviceId = cfg?.micDeviceId && cfg.micDeviceId !== 'default' ? cfg.micDeviceId : undefined;

      // Mic stream — verify saved device still exists before requesting
      if (deviceId) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter(d => d.kind === 'audioinput');
        const found = mics.some(d => d.deviceId === deviceId);
        if (!found) {
          const micNames = mics.map(d => d.label || d.deviceId).join(', ');
          console.warn('[Badge] Saved mic not found. Available:', micNames);
          reportHealth({ micOk: false, systemAudioOk: false, message: 'Microphone not found — go to Settings to reconnect' });
          setState(s => ({
            ...s,
            status: 'error',
            message: 'Microphone not found — go to Settings to reconnect',
          }));
          return;
        }
      }

      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });

      // System audio via desktopCapturer — Windows loopback, graceful fallback elsewhere
      let sysStream: MediaStream | null = null;
      try {
        const sourceId = await (window as any).inwiseAPI.getDesktopSourceId();
        if (sourceId) {
          sysStream = await navigator.mediaDevices.getUserMedia({
            audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } } as any,
            video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } } as any,
          });
          // Drop the video track — we only need audio
          sysStream.getVideoTracks().forEach(t => t.stop());
        }
      } catch {
        sysStream = null;
      }

      if (!sysStream) setSysAudioWarning(true);
      hasStereoRef.current = !!sysStream;

      reportHealth({
        micOk: true,
        systemAudioOk: !!sysStream,
        message: sysStream ? undefined : 'System audio unavailable — only your voice will be recorded',
      });

      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;
      const destination = audioCtx.createMediaStreamDestination();

      if (sysStream) {
        // Stereo: mic → left channel, system → right channel
        const merger = audioCtx.createChannelMerger(2);
        audioCtx.createMediaStreamSource(micStream).connect(merger, 0, 0);
        audioCtx.createMediaStreamSource(sysStream).connect(merger, 0, 1);
        merger.connect(destination);
      } else {
        // Mono: mic only
        audioCtx.createMediaStreamSource(micStream).connect(destination);
      }

      const mr = new MediaRecorder(destination.stream, { mimeType: 'audio/webm;codecs=opus' });
      mediaRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.start(250);
    } catch (e: any) {
      const msg = `Microphone error: ${e?.name || ''} ${e?.message || String(e)}`.trim();
      reportHealth({ micOk: false, systemAudioOk: false, message: msg });
      setState((s) => ({ ...s, status: 'error', message: msg }));
    }
  };

  const stopRecording = async () => {
    const mr = mediaRef.current;
    if (!mr) return;
    mediaRef.current = null;
    mr.stop();
    mr.stream.getTracks().forEach(t => t.stop());
    audioCtxRef.current?.close();
    audioCtxRef.current = null;

    setState(s => ({ ...s, status: 'received' }));

    await new Promise<void>(resolve => { mr.onstop = () => resolve(); });

    const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
    const arrayBuffer = await blob.arrayBuffer();

    // Decode webm/opus → PCM → WAV so Whisper can process it
    const audioCtx = new AudioContext({ sampleRate: 16000 });
    const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    const wav = encodeWav(decoded);
    audioCtx.close();

    (window as any).electronAPI?.sendAudio({
      buffer: new Uint8Array(wav),
      title: titleRef.current,
      calendarEventId: calendarEventIdRef.current,
      stereo: hasStereoRef.current,
    });

    // Close badge only after audio has been sent to main process
    setTimeout(() => window.close(), 3000);
  };

  stopRecordingRef.current = stopRecording;

  function encodeWav(audioBuffer: AudioBuffer): ArrayBuffer {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.getChannelData(0).length;
    const samples = new Int16Array(length * numChannels);

    if (numChannels === 1) {
      const pcm = audioBuffer.getChannelData(0);
      for (let i = 0; i < length; i++) {
        samples[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
      }
    } else {
      // Interleave channels: L0 R0 L1 R1 ...
      const channels: Float32Array[] = [];
      for (let c = 0; c < numChannels; c++) channels.push(audioBuffer.getChannelData(c));
      for (let i = 0; i < length; i++) {
        for (let c = 0; c < numChannels; c++) {
          samples[i * numChannels + c] = Math.max(-32768, Math.min(32767, Math.round(channels[c][i] * 32767)));
        }
      }
    }

    const dataLength = samples.length * 2;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);
    const write = (offset: number, str: string) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
    write(0, 'RIFF'); view.setUint32(4, 36 + dataLength, true);
    write(8, 'WAVE'); write(12, 'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * numChannels * 2, true);
    view.setUint16(32, numChannels * 2, true); view.setUint16(34, 16, true);
    write(36, 'data'); view.setUint32(40, dataLength, true);
    new Int16Array(buffer, 44).set(samples);
    return buffer;
  }

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

  if (state.status === 'received') {
    return (
      <div style={styles.wrap}>
        <div style={{ ...styles.badge, gap: 10 }}>
          <span style={{ fontSize: 16 }}>✓</span>
          <span style={{ ...styles.label, color: '#14b8a6', maxWidth: 260 }}>Processing audio — this window will close automatically</span>
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
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        <div style={styles.badge}>
          <div style={{ ...styles.dot, animation: 'pulse 1s infinite' }} />
          <span style={styles.label}>{state.title}</span>
          <Waveform active />
          <span style={{ color: '#94a3b8', fontSize: 13, fontFamily: 'monospace', minWidth: 42 }}>{fmt(elapsed)}</span>
          <button style={styles.stopBtn} onClick={stopRecording} title="Stop recording">
            <div style={{ width: 10, height: 10, background: 'white', borderRadius: 2 }} />
          </button>
        </div>
        {sysAudioWarning && (
          <div style={{
            background: 'rgba(234,179,8,0.15)',
            border: '1px solid rgba(234,179,8,0.5)',
            borderRadius: 8,
            padding: '4px 12px',
            fontSize: 11,
            color: '#fde047',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          }}>
            ⚠ Mic only — system audio unavailable
          </div>
        )}
      </div>
    </div>
  );
}
