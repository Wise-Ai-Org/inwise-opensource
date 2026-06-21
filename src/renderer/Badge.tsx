import React, { useState, useEffect, useRef } from 'react';

type Status = 'preflight' | 'countdown' | 'recording' | 'processing' | 'done' | 'error' | 'received';

interface PreflightChecks {
  mic: boolean;
  audio: boolean;
  ready: boolean;
}

interface State {
  status: Status;
  message?: string;
  title: string;
  preflight?: PreflightChecks;
  countdown?: number; // 3, 2, 1
  glowActive?: boolean;
}

const INWISE_TEAL = '#0F738C';

// Pre-flight check: verify the saved (or default) mic exists and getUserMedia succeeds.
// Acquires briefly, then releases — startMic() re-acquires for real recording.
async function checkMic(): Promise<{ ok: boolean; error?: string }> {
  const cfg = await (window as any).inwiseAPI?.getConfig?.();
  const savedDeviceId = cfg?.micDeviceId && cfg.micDeviceId !== 'default' ? cfg.micDeviceId : undefined;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: savedDeviceId ? { deviceId: { exact: savedDeviceId } } : true,
    });
    stream.getTracks().forEach(t => t.stop());
    return { ok: true };
  } catch (e: any) {
    // The saved deviceId frequently won't match here: Chromium salts deviceId per
    // browsing context, and the salt rotates across sessions/app restarts. The
    // Settings window saved one salt; this overlay window sees another. So an exact
    // mismatch does NOT mean the mic is gone — fall back to the default device.
    if (savedDeviceId && (e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError')) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
        return { ok: true };
      } catch (e2: any) {
        return { ok: false, error: e2?.message || 'Mic permission denied' };
      }
    }
    return { ok: false, error: e?.message || 'Mic permission denied' };
  }
}

// Pre-flight check: verify desktopCapturer returns a usable system-audio source id.
// Non-blocking failure — recording proceeds mic-only if this fails (existing behavior).
async function checkSystemAudio(): Promise<{ ok: boolean; error?: string }> {
  try {
    const sourceId = await (window as any).inwiseAPI?.getDesktopSourceId?.();
    if (!sourceId) {
      return { ok: false, error: 'System audio source not available' };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'System audio check failed' };
  }
}

// Pre-flight check: verify the IPC bridge is up + config is loadable.
async function checkReady(): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!(window as any).inwiseAPI) return { ok: false, error: 'IPC bridge not initialized' };
    const cfg = await (window as any).inwiseAPI.getConfig();
    if (!cfg) return { ok: false, error: 'Config not loaded' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'IPC not ready' };
  }
}

// Synthesizes a soft 2-tone ascending chime — no audio asset required.
function playStartChime(): void {
  try {
    const ctx = new (window as any).AudioContext();
    const playTone = (freq: number, startOffset: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      const start = ctx.currentTime + startOffset;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
      osc.start(start);
      osc.stop(start + duration);
    };
    playTone(523.25, 0, 0.20);    // C5
    playTone(783.99, 0.10, 0.25); // G5 — ascending fifth = "starting" feel
    setTimeout(() => { try { ctx.close(); } catch { /* ignore */ } }, 600);
  } catch { /* audio failed; non-critical */ }
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
  closeBtn: {
    width: 24,
    height: 24,
    borderRadius: '50%',
    background: 'rgba(255,255,255,0.08)',
    border: 'none',
    color: '#94a3b8',
    fontSize: 14,
    lineHeight: 1,
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
    (window as any).inwiseAPI.on('recording:start', async (title: string, calendarEventId?: string) => {
      titleRef.current = title;
      calendarEventIdRef.current = calendarEventId;

      // Pre-flight: run REAL checks (not setTimeouts). Each dot lights up only when its
      // corresponding check actually passes. Hard failures (mic, ready) abort the countdown.
      // Soft failures (system audio) light the dot red and recording proceeds mic-only.
      setState({ status: 'preflight', title, preflight: { mic: false, audio: false, ready: false } });

      // Run all three checks in parallel for speed
      const [micResult, audioResult, readyResult] = await Promise.all([
        checkMic(),
        checkSystemAudio(),
        checkReady(),
      ]);

      // Hard fail: mic not available — abort with actionable error
      if (!micResult.ok) {
        setState({ status: 'error', title, message: 'Mic check failed: ' + micResult.error });
        return;
      }
      setState(s => ({ ...s, preflight: { mic: true, audio: s.preflight!.audio, ready: s.preflight!.ready } }));
      await new Promise(r => setTimeout(r, 250));

      // Soft fail: system audio missing — proceed but flag it
      setState(s => ({ ...s, preflight: { ...s.preflight!, audio: audioResult.ok } }));
      if (!audioResult.ok) setSysAudioWarning(true);
      await new Promise(r => setTimeout(r, 250));

      // Hard fail: IPC / config not ready
      if (!readyResult.ok) {
        setState({ status: 'error', title, message: 'Not ready: ' + readyResult.error });
        return;
      }
      setState(s => ({ ...s, preflight: { ...s.preflight!, ready: true } }));
      await new Promise(r => setTimeout(r, 350));

      // Countdown
      setState(s => ({ ...s, status: 'countdown', countdown: 3 }));
      await new Promise(r => setTimeout(r, 600));
      setState(s => ({ ...s, countdown: 2 }));
      await new Promise(r => setTimeout(r, 600));
      setState(s => ({ ...s, countdown: 1 }));
      await new Promise(r => setTimeout(r, 600));

      // Start
      playStartChime();
      startRef.current = Date.now();
      setState({ status: 'recording', title });
      startMic(title);

      // Glow fades in 1 second after the chime
      await new Promise(r => setTimeout(r, 1000));
      setState(s => ({ ...s, glowActive: true }));
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

  useEffect(() => {
    if (state.status === 'done') {
      setTimeout(() => window.close(), 2000);
    }
  }, [state.status]);

  const startMic = async (title: string) => {
    const reportHealth = (h: { micOk: boolean; systemAudioOk: boolean; message?: string }) => {
      try { (window as any).electronAPI?.sendAudioHealth(h); } catch { /* ignore */ }
    };
    try {
      const cfg = await (window as any).inwiseAPI.getConfig();
      const deviceId = cfg?.micDeviceId && cfg.micDeviceId !== 'default' ? cfg.micDeviceId : undefined;

      // Mic stream — prefer the saved device, but fall back to the default mic if its
      // deviceId no longer resolves. Chromium salts deviceId per browsing context and
      // rotates the salt across sessions, so the id saved by the Settings window often
      // won't match in this overlay window even though the same mic is present and works.
      let micStream: MediaStream;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        });
      } catch (micErr: any) {
        if (deviceId && (micErr?.name === 'OverconstrainedError' || micErr?.name === 'NotFoundError')) {
          console.warn('[Badge] Saved mic id did not resolve; falling back to default mic.', micErr?.name);
          micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          throw micErr;
        }
      }

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

      // Windows desktopCapturer can hand back a "successful" stream that produces
      // silence when no app is actively routing audio to the captured source.
      // Probe the stream for real content before trusting it — otherwise we write
      // fake-stereo WAVs with a silent right channel and whisper hallucinates.
      let sysAudioSilent = false;
      if (sysStream) {
        const probeCtx = new AudioContext();
        const probeSrc = probeCtx.createMediaStreamSource(sysStream);
        const analyser = probeCtx.createAnalyser();
        analyser.fftSize = 2048;
        probeSrc.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        let maxRms = 0;
        const probeStart = Date.now();
        while (Date.now() - probeStart < 1500) {
          analyser.getFloatTimeDomainData(buf);
          let sumSq = 0;
          for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
          const rms = Math.sqrt(sumSq / buf.length);
          if (rms > maxRms) maxRms = rms;
          if (maxRms > 0.001) break;
          await new Promise(r => setTimeout(r, 50));
        }
        probeSrc.disconnect();
        await probeCtx.close();
        if (maxRms <= 0.001) {
          sysStream.getTracks().forEach(t => t.stop());
          sysStream = null;
          sysAudioSilent = true;
        }
      }

      if (!sysStream) setSysAudioWarning(true);
      hasStereoRef.current = !!sysStream;

      reportHealth({
        micOk: true,
        systemAudioOk: !!sysStream,
        message: sysStream
          ? undefined
          : sysAudioSilent
            ? 'System audio source is silent — check your meeting app is actively playing audio'
            : 'System audio unavailable — only your voice will be recorded',
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

    // Don't show 'received' yet — wait for confirmation from main process
    setState(s => ({ ...s, status: 'processing', message: 'Saving recording…' }));

    try {
      await new Promise<void>(resolve => { mr.onstop = () => resolve(); });

      const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
      if (blob.size === 0) {
        setState(s => ({ ...s, status: 'error', message: 'No audio recorded' }));
        return;
      }
      const arrayBuffer = await blob.arrayBuffer();

      // Decode webm/opus → PCM → WAV so Whisper can process it
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      let decoded: AudioBuffer;
      try {
        // Add timeout to prevent hanging
        const decodePromise = audioCtx.decodeAudioData(arrayBuffer.slice(0));
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Audio decode timeout')), 10000)
        );
        decoded = await Promise.race([decodePromise, timeoutPromise]);
      } catch (decodeErr: any) {
        console.error('[Badge] Audio decode failed:', decodeErr.message);
        setState(s => ({ ...s, status: 'error', message: `Encoding error: ${decodeErr.message}` }));
        audioCtx.close();
        return;
      }
      const wav = encodeWav(decoded);
      audioCtx.close();

      // Send audio to main process and wait for confirmation
      try {
        await (window as any).electronAPI?.sendAudio({
          buffer: new Uint8Array(wav),
          title: titleRef.current,
          calendarEventId: calendarEventIdRef.current,
          stereo: hasStereoRef.current,
        });
      } catch (sendErr: any) {
        throw new Error(`Failed to send recording to main process: ${sendErr?.message || 'Unknown error'}`);
      }

      // Show "Recording saved" immediately - file should be written synchronously in main process
      setState(s => ({ ...s, status: 'received' }));

      // Keep "✓ Recording saved" visible for 7 seconds so user can clearly see it succeeded before closing
      setTimeout(() => window.close(), 7000);
    } catch (err: any) {
      console.error('[Badge] stopRecording error:', err.message);
      setState(s => ({ ...s, status: 'error', message: `Error: ${err.message}` }));
    }
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

  if (state.status === 'preflight') {
    const p = state.preflight ?? { mic: false, audio: false, ready: false };
    const Check = ({ done, label }: { done: boolean; label: string }) => (
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: done ? INWISE_TEAL : 'rgba(255,255,255,0.12)',
          color: 'white',
          fontSize: 10,
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'background 220ms ease',
        }}>{done ? '✓' : ''}</span>
        <span style={{
          color: done ? '#f8fafc' : '#64748b',
          fontSize: 11,
          fontWeight: 500,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          transition: 'color 220ms ease',
        }}>{label}</span>
      </div>
    );
    return (
      <div style={styles.wrap}>
        <div style={{ ...styles.badge, gap: 12 }}>
          <Check done={p.mic} label="Mic" />
          <Check done={p.audio} label="Audio" />
          <Check done={p.ready} label="Ready" />
          <span style={{ ...styles.label, color: '#94a3b8', fontSize: 11, fontWeight: 500 }}>· starting…</span>
        </div>
      </div>
    );
  }

  if (state.status === 'countdown') {
    return (
      <div style={styles.wrap}>
        <div style={{ ...styles.badge, gap: 10 }}>
          <span style={styles.label}>{state.title}</span>
          <span style={{ color: '#94a3b8', fontSize: 12, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>· starting in</span>
          <span style={{
            color: INWISE_TEAL,
            fontSize: 20,
            fontWeight: 700,
            fontFamily: 'monospace',
            minWidth: 18,
            textAlign: 'center',
          }}>{state.countdown}</span>
        </div>
      </div>
    );
  }

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
        <div style={{ ...styles.badge, gap: 10, background: 'rgba(15, 115, 140, 0.97)', borderLeft: '4px solid #14b8a6' }}>
          <span style={{ fontSize: 20 }}>✓</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ ...styles.label, color: '#14b8a6', fontWeight: 700, maxWidth: 260 }}>Recording saved successfully</span>
            <span style={{ ...styles.label, color: '#cbd5e1', fontSize: 11, maxWidth: 260 }}>File saved to disk • closing in 7 seconds</span>
          </div>
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


  const recordingBadgeStyle = state.glowActive ? {
    ...styles.badge,
    animation: 'inwise-glow-pulse 4.5s ease-in-out infinite',
  } : {
    ...styles.badge,
    transition: 'box-shadow 700ms ease-out',
  };

  return (
    <div style={styles.wrap}>
      <style>{`
        @keyframes inwise-glow-pulse {
          0%, 100% {
            box-shadow:
              0 0 0 1.5px rgba(15, 115, 140, 0.65),
              0 0 18px 5px rgba(15, 115, 140, 0.85),
              0 0 38px 12px rgba(15, 115, 140, 0.55),
              0 0 70px 22px rgba(15, 115, 140, 0.28);
          }
          50% {
            box-shadow:
              0 0 0 2px rgba(15, 115, 140, 0.78),
              0 0 24px 7px rgba(15, 115, 140, 0.95),
              0 0 48px 16px rgba(15, 115, 140, 0.65),
              0 0 88px 28px rgba(15, 115, 140, 0.38);
          }
        }
      `}</style>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        <div style={recordingBadgeStyle}>
          <div style={{ ...styles.dot, animation: 'pulse 1s infinite' }} />
          <span style={styles.label}>{state.title}</span>
          <Waveform active />
          <span style={{ color: '#94a3b8', fontSize: 13, fontFamily: 'monospace', minWidth: 42 }}>{fmt(elapsed)}</span>
          <button style={styles.stopBtn} onClick={stopRecording} title="Stop recording">
            <div style={{ width: 10, height: 10, background: 'white', borderRadius: 2 }} />
          </button>
          <button style={styles.closeBtn} onClick={stopRecording} title="Stop & save recording">✕</button>
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
