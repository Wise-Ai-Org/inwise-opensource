import React, { useState, useEffect, useRef } from 'react';
import {
  classifyPendingSystemAudio,
  classifySystemAudioCapture,
  measureStreamRms,
  SystemAudioCaptureState,
} from './audio-probe';
import { captureSystemAudio } from './system-audio';

// Compact recorder pill. Collapsed it is a small capsule with four dots that bob
// with real audio level; hover expands it to show title, timer, and a stop square.
// Left-click runs a device test, right-click opens the native Inwise menu (built
// in main), drag lives on the left grip only so clicks stay clickable.
type Status = 'idle' | 'preflight' | 'countdown' | 'recording' | 'saving' | 'error' | 'reminder';

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
}

// Background transcription jobs (a finished recording being processed while the
// pill may already be recording the next meeting).
type JobState = 'transcribing' | 'processing' | 'done' | 'error';
interface Job { jobId: string; title: string; state: JobState; message?: string }

const INWISE_TEAL = '#0F738C';
const PILL_H = 72; // window height (44px pill + halo margin)
const W_COLLAPSED = 240;
const W_EXPANDED = 470;
const W_MEDIUM = 340;

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
    // The saved deviceId frequently will not match: Chromium salts deviceId per
    // browsing context and the salt rotates across sessions. Fall back to default.
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

// Silent speaker probe for the context menu: routes an AudioContext to the saved
// output and checks it runs. No tick — the audible test stays on left-click.
async function checkSpeakerQuiet(): Promise<boolean> {
  try {
    const cfg = await (window as any).inwiseAPI?.getConfig?.();
    const dev = cfg?.speakerDeviceId && cfg.speakerDeviceId !== 'default' ? cfg.speakerDeviceId : undefined;
    const ctx: AudioContext = new (window as any).AudioContext(dev ? { sinkId: dev } : {});
    await ctx.resume();
    const ok = ctx.state === 'running';
    await ctx.close();
    return ok;
  } catch {
    return false;
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

const styles: Record<string, any> = {
  wrap: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    background: 'transparent',
    padding: 14,
  },
  pill: {
    background: 'rgba(15, 23, 42, 0.97)',
    borderRadius: 22,
    height: 44,
    padding: '0 14px 0 8px',
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    boxShadow: '0 6px 24px rgba(0,0,0,0.4)',
    userSelect: 'none',
    maxWidth: '100%',
    cursor: 'pointer',
  },
  grip: {
    WebkitAppRegion: 'drag',
    width: 14,
    height: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#475569',
    fontSize: 9,
    letterSpacing: -1,
    flexShrink: 0,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    flexShrink: 0,
    transition: 'background 220ms ease',
  },
  label: {
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: 600,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    maxWidth: 160,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
  timer: {
    color: '#94a3b8',
    fontSize: 12,
    fontFamily: 'monospace',
    minWidth: 40,
    flexShrink: 0,
  },
  subtext: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: 500,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
};

function StatusDot({ tone }: { tone: 'ok' | 'fail' | 'pending' }) {
  if (tone === 'pending') return <span className="pill-spinner" />;
  return (
    <span style={{
      width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
      background: tone === 'ok' ? '#22c55e' : '#ef4444',
    }} />
  );
}

export default function Badge() {
  const [state, setState] = useState<State>({ status: 'idle', title: 'Meeting' });
  const [elapsed, setElapsed] = useState(0);
  const [hover, setHover] = useState(false);
  const [systemAudioState, setSystemAudioState] = useState<SystemAudioCaptureState>('ok');
  const sysAudioWarning = systemAudioState !== 'ok';
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [test, setTest] = useState<null | { mic: 'pending' | 'ok' | 'fail'; spk: 'pending' | 'ok' | 'fail' }>(null);

  const startRef = useRef(Date.now());
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const systemStreamRef = useRef<MediaStream | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const mergerRef = useRef<ChannelMergerNode | null>(null);
  const destinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const hasStereoRef = useRef(false);
  const stopRecordingRef = useRef<() => void>(() => {});
  const titleRef = useRef<string>('Meeting');
  const calendarEventIdRef = useRef<string | undefined>(undefined);
  const beginFlowRef = useRef<(title: string) => void>(() => {});
  const runIdRef = useRef(0);
  const dotRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const levelRef = useRef(0);
  const testTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror status into a ref so mount-only listeners read it without stale closures.
  const statusRef = useRef(state.status);
  statusRef.current = state.status;

  useEffect(() => {
    const api = (window as any).inwiseAPI;

    api.on('recording:start', (title: string, calendarEventId?: string) => {
      calendarEventIdRef.current = calendarEventId;
      beginFlowRef.current(title);
    });

    api.on('reminder:start', (title: string) => {
      titleRef.current = title;
      setState({ status: 'reminder', title });
    });

    api.on('recording:stop-request', () => {
      stopRecordingRef.current();
    });

    api.on('pipeline:secondary', (msg: Job) => {
      if (!msg?.jobId) return;
      setJobs(prev => ({ ...prev, [msg.jobId]: msg }));
      if (msg.state === 'done') {
        // Long enough to read the "open Inwise" invite; main closes the pill on
        // a matching delay once the queue drains.
        setTimeout(() => setJobs(prev => {
          const next = { ...prev };
          delete next[msg.jobId];
          return next;
        }), 6000);
      }
    });

    api.on('pill:switch-mic', (deviceId: string) => {
      if (statusRef.current === 'recording') void swapMicRef.current(deviceId);
    });

    // Re-run the mic check when audio hardware changes while we're parked on the
    // error screen, so reconnecting/fixing the mic auto-recovers the flow instead
    // of staying stuck (the check previously ran only once per recording:start).
    const onDeviceChange = async () => {
      if (statusRef.current !== 'error') return;
      const res = await checkMic();
      if (res.ok) beginFlowRef.current(titleRef.current);
    };
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);

    beginFlowRef.current = async (title: string) => {
      titleRef.current = title;
      setSystemAudioState('ok');
      const myRun = ++runIdRef.current;
      const alive = () => runIdRef.current === myRun;

      // Pre-flight: run REAL checks (not setTimeouts). Each dot lights up only when its
      // corresponding check actually passes. Hard failures (mic, ready) abort the countdown.
      // Soft failures (system audio) turn the dot amber and recording proceeds mic-only.
      setState({ status: 'preflight', title, preflight: { mic: false, audio: false, ready: false } });

      const [micResult, audioResult, readyResult] = await Promise.all([
        checkMic(),
        checkSystemAudio(),
        checkReady(),
      ]);
      if (!alive()) return;

      // Hard fail: mic not available — abort with actionable error
      if (!micResult.ok) {
        setState({ status: 'error', title, message: 'Mic check failed: ' + micResult.error });
        return;
      }
      setState(s => ({ ...s, preflight: { mic: true, audio: s.preflight!.audio, ready: s.preflight!.ready } }));
      await new Promise(r => setTimeout(r, 250));
      if (!alive()) return;

      // Soft fail: system audio missing — proceed but flag it
      setState(s => ({ ...s, preflight: { ...s.preflight!, audio: audioResult.ok } }));
      if (!audioResult.ok) setSystemAudioState('missing');
      await new Promise(r => setTimeout(r, 250));
      if (!alive()) return;

      // Hard fail: IPC / config not ready
      if (!readyResult.ok) {
        setState({ status: 'error', title, message: 'Not ready: ' + readyResult.error });
        return;
      }
      setState(s => ({ ...s, preflight: { ...s.preflight!, ready: true } }));
      await new Promise(r => setTimeout(r, 350));
      if (!alive()) return;

      // Countdown — clicking the pill cancels (runIdRef bump makes alive() false)
      setState(s => ({ ...s, status: 'countdown', countdown: 3 }));
      await new Promise(r => setTimeout(r, 600));
      if (!alive()) return;
      setState(s => ({ ...s, countdown: 2 }));
      await new Promise(r => setTimeout(r, 600));
      if (!alive()) return;
      setState(s => ({ ...s, countdown: 1 }));
      await new Promise(r => setTimeout(r, 600));
      if (!alive()) return;

      // Start
      playStartChime();
      startRef.current = Date.now();
      setElapsed(0);
      setState({ status: 'recording', title });
      startMic();
    };

    return () => navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
  }, []);

  useEffect(() => {
    if (state.status !== 'recording') return;
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  // Drive the four dots from real audio level — direct DOM writes, no re-render.
  useEffect(() => {
    if (state.status !== 'recording') {
      dotRefs.current.forEach(el => { if (el) el.style.transform = ''; });
      return;
    }
    let raf = 0;
    const buf = new Float32Array(1024);
    const phases = [0.55, 1.0, 0.8, 0.45];
    const tick = () => {
      const an = analyserRef.current;
      if (an) {
        an.getFloatTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
        const rms = Math.sqrt(sumSq / buf.length);
        // fast attack, slow decay — mild motion, capped at 5px lift
        levelRef.current = Math.max(rms, levelRef.current * 0.93);
        const lift = Math.min(5, levelRef.current * 160);
        const t = Date.now() / 260;
        dotRefs.current.forEach((el, i) => {
          if (!el) return;
          const y = lift * phases[i] * (0.75 + 0.25 * Math.sin(t + i * 1.7));
          el.style.transform = `translateY(${(-y).toFixed(1)}px)`;
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state.status]);

  const startMic = async () => {
    const reportHealth = (h: { micOk: boolean; systemAudioOk: boolean; message?: string }) => {
      try { (window as any).electronAPI?.sendAudioHealth(h); } catch { /* ignore */ }
    };
    try {
      const cfg = await (window as any).inwiseAPI.getConfig();
      const deviceId = cfg?.micDeviceId && cfg.micDeviceId !== 'default' ? cfg.micDeviceId : undefined;

      // Mic stream — prefer the saved device, fall back to default if its deviceId
      // no longer resolves (Chromium salts/rotates deviceId across contexts/sessions).
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

      // System audio uses the same Chromium capture path on Windows and macOS.
      // macOS permission state changes how initial silence is interpreted: a quiet
      // call must not permanently discard an otherwise healthy capture stream.
      const permissions = await (window as any).inwiseAPI.getMediaPermissions?.() ?? {
        platform: 'unknown', microphone: 'unknown', screen: 'unknown',
      };
      let sysStream: MediaStream | null = null;
      let sysCaptureError = '';
      try {
        sysStream = await captureSystemAudio();
      } catch (error: any) {
        sysCaptureError = error?.message || String(error);
        sysStream = null;
      }

      const initialRms = sysStream ? await measureStreamRms(sysStream, 1500) : 0;
      const initialSystemState = classifySystemAudioCapture(!!sysStream, initialRms, permissions);
      if (initialSystemState === 'missing' && sysStream) {
        sysStream.getTracks().forEach(t => t.stop());
        sysStream = null;
      }

      setSystemAudioState(initialSystemState);
      systemStreamRef.current = sysStream;
      // Only enable diarization once the right channel has carried real audio.
      // The stream remains connected while pending so a quiet call can recover.
      hasStereoRef.current = initialSystemState === 'ok';

      reportHealth({
        micOk: true,
        systemAudioOk: !!sysStream,
        message: initialSystemState === 'ok'
          ? undefined
          : initialSystemState === 'pending'
            ? 'System audio is connected; waiting for another participant to speak'
            : permissions.screen === 'denied' || permissions.screen === 'restricted'
              ? 'Screen & System Audio Recording permission is disabled in System Settings'
              : sysCaptureError || 'System audio unavailable — only your voice will be recorded',
      });

      if (sysStream) {
        const capturedStream = sysStream;
        capturedStream.getAudioTracks()[0]?.addEventListener('ended', () => {
          if (systemStreamRef.current !== capturedStream) return;
          systemStreamRef.current = null;
          hasStereoRef.current = false;
          setSystemAudioState('missing');
          reportHealth({
            micOk: true,
            systemAudioOk: false,
            message: 'System audio capture ended — only your microphone is still being recorded',
          });
        });
        if (initialSystemState === 'pending') {
          void (async () => {
            const pendingStartedAt = Date.now();
            let silenceReported = false;
            while (systemStreamRef.current === capturedStream) {
              let maxRms = 0;
              try {
                maxRms = await measureStreamRms(capturedStream, 15_000);
              } catch {
                return; // the track-ended handler owns failure reporting
              }
              if (systemStreamRef.current !== capturedStream) return;
              const nextState = classifyPendingSystemAudio(maxRms, Date.now() - pendingStartedAt);
              if (nextState === 'ok') {
                hasStereoRef.current = true;
                setSystemAudioState('ok');
                reportHealth({ micOk: true, systemAudioOk: true });
                return;
              }
              if (nextState === 'missing' && !silenceReported) {
                silenceReported = true;
                hasStereoRef.current = false;
                setSystemAudioState('missing');
                reportHealth({
                  micOk: true,
                  systemAudioOk: false,
                  message: 'No system audio detected — check Screen & System Audio Recording permission and call output',
                });
              }
            }
          })();
        }
      }

      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;
      const destination = audioCtx.createMediaStreamDestination();
      destinationRef.current = destination;
      const micSource = audioCtx.createMediaStreamSource(micStream);
      micSourceRef.current = micSource;
      micStreamRef.current = micStream;

      // Analyser taps the mixed signal so the pill dots move for anyone speaking,
      // not just the local mic.
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyserRef.current = analyser;

      if (sysStream) {
        // Stereo: mic → left channel, system → right channel
        const merger = audioCtx.createChannelMerger(2);
        mergerRef.current = merger;
        micSource.connect(merger, 0, 0);
        audioCtx.createMediaStreamSource(sysStream).connect(merger, 0, 1);
        merger.connect(destination);
        merger.connect(analyser);
      } else {
        // Mono: mic only
        mergerRef.current = null;
        micSource.connect(destination);
        micSource.connect(analyser);
      }

      const mr = new MediaRecorder(destination.stream, { mimeType: 'audio/webm;codecs=opus' });
      mediaRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.start(250);
    } catch (e: any) {
      systemStreamRef.current?.getTracks().forEach(t => t.stop());
      systemStreamRef.current = null;
      const msg = `Microphone error: ${e?.name || ''} ${e?.message || String(e)}`.trim();
      reportHealth({ micOk: false, systemAudioOk: false, message: msg });
      setState((s) => ({ ...s, status: 'error', message: msg }));
    }
  };

  // Live mic switch mid-recording: swap the source node feeding the existing graph.
  // The MediaRecorder consumes the AudioContext destination, so it never notices.
  const swapMicRef = useRef<(deviceId: string) => Promise<void>>(async () => {});
  swapMicRef.current = async (deviceId: string) => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : true,
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    const src = ctx.createMediaStreamSource(stream);
    if (mergerRef.current) {
      src.connect(mergerRef.current, 0, 0);
    } else if (destinationRef.current) {
      src.connect(destinationRef.current);
      if (analyserRef.current) src.connect(analyserRef.current);
    }
    try { micSourceRef.current?.disconnect(); } catch { /* ignore */ }
    micStreamRef.current?.getTracks().forEach(t => t.stop());
    micSourceRef.current = src;
    micStreamRef.current = stream;
  };

  const stopRecording = async () => {
    const mr = mediaRef.current;
    if (!mr) return;
    mediaRef.current = null;
    mr.stop();
    mr.stream.getTracks().forEach(t => t.stop());
    micStreamRef.current?.getTracks().forEach(t => t.stop());
    micStreamRef.current = null;
    systemStreamRef.current?.getTracks().forEach(t => t.stop());
    systemStreamRef.current = null;
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    analyserRef.current = null;

    setState(s => ({ ...s, status: 'saving' }));

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
    // Main owns the window lifecycle from here — it closes the pill once every
    // queued transcription has drained (never mid-transcription).
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

  // ── Device test (left-click): real signal check, green or red per device ──

  const runDeviceTest = async () => {
    if (test) { // second click dismisses the result early
      if (testTimerRef.current) clearTimeout(testTimerRef.current);
      setTest(null);
      return;
    }
    setTest({ mic: 'pending', spk: 'pending' });
    const cfg = await (window as any).inwiseAPI.getConfig();

    const micPromise = (async (): Promise<'ok' | 'fail'> => {
      try {
        const saved = cfg?.micDeviceId && cfg.micDeviceId !== 'default' ? cfg.micDeviceId : undefined;
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: saved ? { deviceId: { exact: saved } } : true });
        } catch (e: any) {
          if (saved && (e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError')) {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          } else {
            throw e;
          }
        }
        const track = stream.getAudioTracks()[0];
        let ok = !!track && track.readyState === 'live' && !track.muted;
        if (ok) {
          // A live mic always yields at least noise-floor samples; flat zeros for
          // 1.2s means a dead or disconnected virtual device.
          const ctx = new AudioContext();
          const src = ctx.createMediaStreamSource(stream);
          const an = ctx.createAnalyser();
          an.fftSize = 1024;
          src.connect(an);
          const buf = new Float32Array(an.fftSize);
          let nonZero = false;
          const t0 = Date.now();
          while (Date.now() - t0 < 1200) {
            an.getFloatTimeDomainData(buf);
            for (let i = 0; i < buf.length; i++) { if (buf[i] !== 0) { nonZero = true; break; } }
            if (nonZero) break;
            await new Promise(r => setTimeout(r, 60));
          }
          await ctx.close();
          ok = nonZero;
        }
        stream.getTracks().forEach(t => t.stop());
        return ok ? 'ok' : 'fail';
      } catch {
        return 'fail';
      }
    })();

    const spkPromise = (async (): Promise<'ok' | 'fail'> => {
      try {
        const dev = cfg?.speakerDeviceId && cfg.speakerDeviceId !== 'default' ? cfg.speakerDeviceId : undefined;
        // sinkId in AudioContext options routes to the selected output (Chromium 110+).
        const ctx: AudioContext = new (window as any).AudioContext(dev ? { sinkId: dev } : {});
        await ctx.resume();
        // One soft tick, well under the start-chime volume, so green means audible —
        // a fully silent check would only prove the device exists.
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 660;
        osc.type = 'sine';
        const t = ctx.currentTime;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.05, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        osc.start(t);
        osc.stop(t + 0.14);
        await new Promise(r => setTimeout(r, 220));
        const ok = ctx.state === 'running';
        await ctx.close();
        return ok ? 'ok' : 'fail';
      } catch {
        return 'fail';
      }
    })();

    micPromise.then(r => setTest(s => (s ? { ...s, mic: r } : s)));
    spkPromise.then(r => setTest(s => (s ? { ...s, spk: r } : s)));
    const [micR, spkR] = await Promise.all([micPromise, spkPromise]);
    const hold = micR === 'fail' || spkR === 'fail' ? 8000 : 3500;
    if (testTimerRef.current) clearTimeout(testTimerRef.current);
    testTimerRef.current = setTimeout(() => setTest(null), hold);
  };

  // ── Interactions ──

  const cancelCountdown = () => {
    runIdRef.current++;
    setState(s => ({ ...s, status: 'idle' }));
    (window as any).inwiseAPI.pillCancelled?.();
  };

  const onPillClick = () => {
    if (state.status === 'countdown' || state.status === 'preflight') { cancelCountdown(); return; }
    if (state.status === 'reminder') { window.close(); return; }
    if (state.status === 'saving') { (window as any).inwiseAPI.openInwise?.(); return; }
    void runDeviceTest();
  };

  const onContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    // Mid-recording the live mic stream is the truth; otherwise a quick
    // acquire-and-release probe. Both run alongside device enumeration.
    const micOkPromise: Promise<boolean> = (async () => {
      if (statusRef.current === 'recording') {
        const track = micStreamRef.current?.getAudioTracks()[0];
        return !!track && track.readyState === 'live' && !track.muted;
      }
      return (await checkMic()).ok;
    })();
    let mics: { id: string; label: string }[] = [];
    let speakers: { id: string; label: string }[] = [];
    const [devices, micOk, spkOk] = await Promise.all([
      navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]),
      micOkPromise,
      checkSpeakerQuiet(),
    ]);
    mics = devices
      .filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'communications')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
    speakers = devices
      .filter(d => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'communications')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Speaker ${i + 1}` }));
    (window as any).inwiseAPI.showPillMenu?.({
      mics,
      speakers,
      micOk,
      spkOk,
      recording: statusRef.current === 'recording',
      title: titleRef.current,
    });
  };

  // ── Window sizing: pill is left-anchored, so the window grows rightward ──

  const jobList = Object.values(jobs);
  const busyJob = jobList.find(j => j.state === 'transcribing' || j.state === 'processing');
  const errorJob = jobList.find(j => j.state === 'error');
  const doneFlash = !busyJob && !errorJob && jobList.some(j => j.state === 'done');

  const wantWidth = (() => {
    if (state.status === 'error') return W_EXPANDED;
    if (test) return W_MEDIUM;
    if (state.status === 'countdown' || state.status === 'preflight') return W_MEDIUM;
    if (state.status === 'reminder') return W_MEDIUM;
    if (state.status === 'recording') return hover ? W_EXPANDED : W_COLLAPSED;
    if (state.status === 'saving') return doneFlash ? W_MEDIUM : hover ? W_EXPANDED : W_COLLAPSED;
    return W_COLLAPSED;
  })();

  useEffect(() => {
    (window as any).inwiseAPI.resizePill?.(wantWidth, PILL_H);
  }, [wantWidth]);

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const truncate = (s: string, n = 30) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  // ── Render pieces ──

  const grip = <div style={styles.grip} title="Drag to move">⋮⋮</div>;

  // Secondary slot: a previous meeting still transcribing (or failed) while the
  // pill is busy with the current one.
  const secondaryDot = (state.status === 'recording' || state.status === 'countdown' || state.status === 'preflight') && (busyJob || errorJob)
    ? (errorJob ? <StatusDot tone="fail" /> : <span className="pill-spinner" />)
    : null;

  const renderDots = (fills: string[]) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {fills.map((bg, i) => (
        <span key={i} ref={el => { dotRefs.current[i] = el; }} style={{ ...styles.dot, background: bg }} />
      ))}
    </div>
  );

  const DIM = 'rgba(255,255,255,0.16)';
  const TEAL = '#14b8a6';
  const AMBER = '#f59e0b';

  let body: React.ReactNode;

  if (test) {
    body = (
      <>
        {grip}
        <span style={{ ...styles.subtext, color: '#94a3b8' }}>Mic</span>
        <StatusDot tone={test.mic} />
        <span style={{ ...styles.subtext, color: '#94a3b8', marginLeft: 4 }}>Speaker</span>
        <StatusDot tone={test.spk} />
        {(test.mic === 'fail' || test.spk === 'fail') && (
          <span style={{ ...styles.subtext, color: '#fca5a5' }}>right-click to switch</span>
        )}
      </>
    );
  } else if (state.status === 'preflight') {
    const p = state.preflight ?? { mic: false, audio: false, ready: false };
    body = (
      <>
        {grip}
        {renderDots([
          p.mic ? TEAL : DIM,
          p.audio ? TEAL : (sysAudioWarning ? AMBER : DIM),
          p.ready ? TEAL : DIM,
          p.mic && p.ready ? TEAL : DIM,
        ])}
        <span style={styles.subtext}>checking…</span>
      </>
    );
  } else if (state.status === 'countdown') {
    body = (
      <>
        {grip}
        <span style={{ color: INWISE_TEAL, fontSize: 18, fontWeight: 700, fontFamily: 'monospace', minWidth: 14, textAlign: 'center' }}>
          {state.countdown}
        </span>
        <span style={styles.label} title={state.title}>{truncate(state.title)}</span>
        <span style={styles.subtext}>click to cancel</span>
      </>
    );
  } else if (state.status === 'error') {
    body = (
      <>
        {grip}
        <span style={{ fontSize: 14, flexShrink: 0 }}>⚠</span>
        <span style={{ ...styles.label, color: '#fca5a5', maxWidth: 210 }} title={state.message}>{state.message || 'Error'}</span>
        <button
          className="pill-btn"
          onClick={(e) => { e.stopPropagation(); beginFlowRef.current(titleRef.current); }}
        >
          Retry
        </button>
        <button
          className="pill-btn pill-btn-ghost"
          onClick={(e) => { e.stopPropagation(); void onContextMenu(e as any); }}
        >
          Devices
        </button>
      </>
    );
  } else if (state.status === 'reminder') {
    body = (
      <>
        {grip}
        <span style={{ fontSize: 13, flexShrink: 0 }}>🔔</span>
        <span style={styles.label} title={state.title}>{truncate(state.title)}</span>
        <span style={styles.subtext}>starting soon · click to dismiss</span>
      </>
    );
  } else if (state.status === 'saving') {
    // Post-stop: coalescing, then the transcription queue reports through jobs.
    const label = errorJob
      ? `Transcription failed — ${truncate(errorJob.title, 22)}`
      : busyJob
        ? `${busyJob.state === 'processing' ? 'Analyzing' : 'Transcribing'} — ${truncate(busyJob.title, 22)}`
        : doneFlash
          ? 'Saved — open Inwise to see insights'
          : 'Saving…';
    body = (
      <>
        {grip}
        {errorJob ? <StatusDot tone="fail" /> : doneFlash ? <StatusDot tone="ok" /> : <span className="pill-spinner" />}
        <span style={{ ...styles.label, color: errorJob ? '#fca5a5' : doneFlash ? TEAL : '#94a3b8', maxWidth: doneFlash ? 280 : hover ? 300 : 140 }} title={errorJob?.message || label}>
          {label}
        </span>
      </>
    );
  } else {
    // recording (and brief idle)
    const recording = state.status === 'recording';
    body = (
      <>
        {grip}
        {secondaryDot}
        {renderDots(recording
          ? [TEAL, sysAudioWarning ? AMBER : TEAL, TEAL, TEAL]
          : [DIM, DIM, DIM, DIM])}
        {recording && hover && (
          <>
            <span style={styles.label} title={state.title + (systemAudioState === 'missing' ? ' (mic only)' : systemAudioState === 'pending' ? ' (waiting for system audio)' : '')}>{truncate(state.title)}</span>
            {busyJob && (
              <span style={{ ...styles.subtext, maxWidth: 90 }} title={`Transcribing — ${busyJob.title}`}>
                ⟳ {truncate(busyJob.title, 14)}
              </span>
            )}
            {sysAudioWarning && !busyJob && (
              <span style={{ ...styles.subtext, color: AMBER }}>
                {systemAudioState === 'pending' ? 'waiting for call audio' : 'mic only'}
              </span>
            )}
            <span style={styles.timer}>{fmt(elapsed)}</span>
            <button
              className="pill-stop"
              title="Stop & save"
              onClick={(e) => { e.stopPropagation(); void stopRecording(); }}
            >
              <span className="pill-stop-inner" />
            </button>
          </>
        )}
      </>
    );
  }

  // Recording: steady thick teal ring + halo — no pulsing fade, easy to spot at a glance.
  const pillStyle = state.status === 'recording'
    ? {
        ...styles.pill,
        boxShadow: '0 0 0 2.5px rgba(20,184,166,0.95), 0 0 14px 5px rgba(20,184,166,0.38), 0 0 26px 10px rgba(15,115,140,0.18), 0 6px 24px rgba(0,0,0,0.4)',
      }
    : state.status === 'error'
      ? { ...styles.pill, boxShadow: '0 0 0 1px rgba(239,68,68,0.6), 0 6px 24px rgba(0,0,0,0.4)' }
      : styles.pill;

  return (
    <div style={styles.wrap}>
      <style>{`
        @keyframes pill-spin { to { transform: rotate(360deg); } }
        .pill-spinner {
          width: 9px; height: 9px; flex-shrink: 0;
          border: 1.5px solid rgba(255,255,255,0.2);
          border-top-color: #14b8a6;
          border-radius: 50%;
          display: inline-block;
          animation: pill-spin 0.9s linear infinite;
        }
        .pill-btn {
          background: ${INWISE_TEAL}; color: #fff; border: none; border-radius: 8px;
          padding: 5px 10px; font-size: 11px; font-weight: 600; cursor: pointer; flex-shrink: 0;
        }
        .pill-btn-ghost { background: rgba(255,255,255,0.08); color: #cbd5e1; }
        .pill-btn-ghost:hover { background: rgba(255,255,255,0.15); }
        .pill-stop {
          width: 20px; height: 20px; flex-shrink: 0; cursor: pointer;
          background: transparent; border: 1.5px solid #64748b; border-radius: 5px;
          display: flex; align-items: center; justify-content: center;
          transition: border-color 150ms ease;
        }
        .pill-stop:hover { border-color: #ef4444; }
        .pill-stop-inner {
          width: 8px; height: 8px; border-radius: 1.5px; background: #94a3b8;
          transition: background 150ms ease;
        }
        .pill-stop:hover .pill-stop-inner { background: #ef4444; }
      `}</style>
      <div
        className="pill-root"
        style={pillStyle}
        onClick={onPillClick}
        onContextMenu={onContextMenu}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {body}
      </div>
    </div>
  );
}
