import { decodeVoiceRecording, stopVoiceRecorder } from './voice-audio';
import React, { useState, useEffect, useRef } from 'react';
import {
  classifySystemAudioCapture,
  measureStreamRms,
} from './audio-probe';
import { captureSystemAudio } from './system-audio';
import {
  RecordingSilenceWatchdog,
  RECORDING_SILENCE_CHECK_IN_MS,
  RECORDING_SOUND_RMS_THRESHOLD,
} from './recording-silence';

// Floating recorder with a dark surface and teal audio glow. Live audio dots,
// title, timer, stop, and device settings remain visible while recording.
// Left-click runs a device test, right-click opens the native Inwise menu (built
// in main), and the pill can be dragged from any area except its buttons.
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
interface Job { jobId: string; title: string; state: JobState; message?: string; meetingId?: string }

interface SilencePrompt {
  title: string;
  deadlineAt: number;
}

const INWISE_TEAL = '#0F738C';
const PILL_H = 100; // 68px recorder plus glow margin
const W_COLLAPSED = 500;
const W_EXPANDED = 560;
const W_MEDIUM = 500;
const W_SILENCE_PROMPT = 560;
const W_COMPLETED = 620;

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
    background: 'radial-gradient(ellipse at 16% var(--glow-left-y, 125%), rgba(15,115,140,0.88), transparent 62%), radial-gradient(ellipse at 90% var(--glow-right-y, 135%), rgba(20,184,166,0.55), transparent 62%), linear-gradient(115deg, #0b1622, #0d2935 68%, #10212e)',
    borderRadius: 16,
    border: 'none',
    height: 68,
    width: '100%',
    position: 'relative',
    overflow: 'hidden',
    padding: '0 14px 0 8px',
    fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    boxShadow: 'none',
    userSelect: 'none',
    maxWidth: '100%',
    cursor: 'pointer',
  },
  grip: {
    width: 22,
    height: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#94a3b8',
    fontSize: 15,
    cursor: 'grab',
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
    color: '#ccfbf1',
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
  const [sysAudioIssue, setSysAudioIssue] = useState<'none' | 'waiting' | 'unavailable'>('none');
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [test, setTest] = useState<null | { mic: 'pending' | 'ok' | 'fail'; spk: 'pending' | 'ok' | 'fail' }>(null);
  const [silencePrompt, setSilencePrompt] = useState<SilencePrompt | null>(null);
  const [silenceSecondsLeft, setSilenceSecondsLeft] = useState(30);

  const startRef = useRef(Date.now());
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const savedRawRef = useRef<{id: string; duration: number} | null>(null);
  const finalizingRef = useRef(false);
  const rawAttemptRef = useRef<string | undefined>();
  const stopRetryRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const systemStreamRef = useRef<MediaStream | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const systemSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const systemMonitorRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const systemRecoveryRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const systemWarningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const systemIgnoredRef = useRef(false);
  const scheduleSystemRecoveryRef = useRef<() => void>(() => {});
  const recoverSystemAudioRef = useRef<() => Promise<boolean>>(async () => false);
  const mergerRef = useRef<ChannelMergerNode | null>(null);
  const destinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceWatchdogRef = useRef(new RecordingSilenceWatchdog());
  const silencePromptRef = useRef<SilencePrompt | null>(null);
  const hasStereoRef = useRef(false);
  const stopRecordingRef = useRef<() => void>(() => {});
  const titleRef = useRef<string>('Meeting');
  const calendarEventIdRef = useRef<string | undefined>(undefined);
  const attendeesRef = useRef<string[]>([]);
  const beginFlowRef = useRef<(title: string) => void>(() => {});
  const runIdRef = useRef(0);
  const dotRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const levelRef = useRef(0);
  const recorderRef = useRef<HTMLDivElement | null>(null);
  const testTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestCompletedMeetingRef = useRef<string | undefined>(undefined);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  // Mirror status into a ref so mount-only listeners read it without stale closures.
  const statusRef = useRef(state.status);
  statusRef.current = state.status;
  const sysAudioIssueRef = useRef(sysAudioIssue);
  sysAudioIssueRef.current = sysAudioIssue;

  useEffect(() => {
    const api = (window as any).inwiseAPI;

    api.on('recording:start', (title: string, calendarEventId?: string, attendees?: string[]) => {
      silencePromptRef.current = null;
      setSilencePrompt(null);
      calendarEventIdRef.current = calendarEventId;
      attendeesRef.current = Array.isArray(attendees) ? attendees.filter(Boolean) : [];
      beginFlowRef.current(title);
    });

    api.on('reminder:start', (title: string) => {
      titleRef.current = title;
      setState({ status: 'reminder', title });
    });

    api.on('recording:silence-reset', () => silenceWatchdogRef.current.reset());

    api.on('recording:stop-request', () => {
      if (statusRef.current === 'preflight' || statusRef.current === 'countdown') {
        runIdRef.current += 1;
        setState((current) => ({ ...current, status: 'idle' }));
        api.pillCancelled?.();
        return;
      }
      stopRecordingRef.current();
    });

    api.on('recording:silence-prompt', (payload: { title?: string; deadlineAt?: number }) => {
      if (statusRef.current !== 'recording') return;
      const prompt: SilencePrompt = {
        title: typeof payload?.title === 'string' && payload.title.trim()
          ? payload.title.trim()
          : titleRef.current,
        deadlineAt: typeof payload?.deadlineAt === 'number'
          ? payload.deadlineAt
          : Date.now() + 30_000,
      };
      silencePromptRef.current = prompt;
      setSilencePrompt(prompt);
    });

    api.on('recording:silence-resolved', () => {
      silencePromptRef.current = null;
      setSilencePrompt(null);
      silenceWatchdogRef.current.reset();
    });

    api.on('pipeline:secondary', (msg: Job) => {
      if (!msg?.jobId) return;
      setJobs(prev => ({ ...prev, [msg.jobId]: msg }));
      if (msg.state === 'done') {
        latestCompletedMeetingRef.current = msg.meetingId;
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
      systemIgnoredRef.current = false;
      if (systemRecoveryRef.current) clearInterval(systemRecoveryRef.current);
      if (systemWarningTimerRef.current) clearTimeout(systemWarningTimerRef.current);
      setSysAudioIssue('none');
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
      if (!audioResult.ok) setSysAudioIssue('unavailable');
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
    silenceWatchdogRef.current.reset();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  useEffect(() => {
    if (!silencePrompt) return;
    const update = () => {
      setSilenceSecondsLeft(Math.max(0, Math.ceil((silencePrompt.deadlineAt - Date.now()) / 1000)));
    };
    update();
    const id = setInterval(update, 250);
    return () => clearInterval(id);
  }, [silencePrompt]);

  // Drive the four dots from real audio level — direct DOM writes, no re-render.
  useEffect(() => {
    if (state.status !== 'recording') {
      dotRefs.current.forEach(el => { if (el) el.style.transform = ''; });
      recorderRef.current?.style.removeProperty('--glow-left-y');
      recorderRef.current?.style.removeProperty('--glow-right-y');
      levelRef.current = 0;
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
        if (silencePromptRef.current && rms >= RECORDING_SOUND_RMS_THRESHOLD) {
          silencePromptRef.current = null;
          setSilencePrompt(null);
          silenceWatchdogRef.current.reset();
          (window as any).inwiseAPI?.respondRecordingSilence?.('sound');
        }
        if (!silencePromptRef.current && silenceWatchdogRef.current.observe(rms)) {
          (window as any).inwiseAPI?.notifyRecordingSilence?.({
            title: titleRef.current,
            silenceMs: RECORDING_SILENCE_CHECK_IN_MS,
          });
        }
        // fast attack, slow decay — mild motion, capped at 5px lift
        levelRef.current = Math.max(rms, levelRef.current * 0.93);
        const lift = Math.min(5, levelRef.current * 160);
        const t = Date.now() / 260;
        // Speech raises the soft glow; quiet lets it settle below the controls.
        const strength = Math.min(1, levelRef.current * 18);
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (recorderRef.current && !reducedMotion) {
          recorderRef.current.style.setProperty('--glow-left-y', `${125 - strength * (43 + 7 * Math.sin(t * 0.35))}%`);
          recorderRef.current.style.setProperty('--glow-right-y', `${135 - strength * (48 + 8 * Math.sin(t * 0.35 + 1.8))}%`);
        }
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
      setSysAudioIssue('none');
      hasStereoRef.current = false;
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
      // Keep a successfully acquired system stream alive even when the meeting
      // starts in silence. A final WAV-level check decides whether its channel is
      // actually usable after the recording has ended.
      systemStreamRef.current = sysStream;
      hasStereoRef.current = !!sysStream;
      setSysAudioIssue(!sysStream ? 'unavailable' : initialSystemState === 'ok' ? 'none' : 'waiting');
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
        const systemSource = audioCtx.createMediaStreamSource(sysStream);
        systemSourceRef.current = systemSource;
        systemSource.connect(merger, 0, 1);
        merger.connect(destination);
        merger.connect(analyser);

        // A quiet start is normal. Monitor until real call audio arrives, but do
        // not stop or disconnect the stream while waiting.
        const systemAnalyser = audioCtx.createAnalyser();
        systemAnalyser.fftSize = 2048;
        systemSource.connect(systemAnalyser);
        const systemSamples = new Float32Array(systemAnalyser.fftSize);
        systemMonitorRef.current = setInterval(() => {
          systemAnalyser.getFloatTimeDomainData(systemSamples);
          let sumSq = 0;
          for (let i = 0; i < systemSamples.length; i++) sumSq += systemSamples[i] * systemSamples[i];
          const rms = Math.sqrt(sumSq / systemSamples.length);
          if (rms > 0.001) {
            setSysAudioIssue('none');
            reportHealth({ micOk: true, systemAudioOk: true });
            if (systemMonitorRef.current) clearInterval(systemMonitorRef.current);
            systemMonitorRef.current = null;
            if (systemRecoveryRef.current) clearInterval(systemRecoveryRef.current);
            systemRecoveryRef.current = null;
            if (systemWarningTimerRef.current) clearTimeout(systemWarningTimerRef.current);
            systemWarningTimerRef.current = null;
          }
        }, 250);
        const track = sysStream.getAudioTracks()[0];
        track?.addEventListener('ended', () => {
          if (systemIgnoredRef.current) return;
          reportHealth({ micOk: true, systemAudioOk: false, message: 'Other speaker audio unavailable' });
          setSysAudioIssue('waiting');
          scheduleSystemRecoveryRef.current();
        });
        track?.addEventListener('mute', () => {
          if (systemIgnoredRef.current) return;
          reportHealth({ micOk: true, systemAudioOk: false, message: 'Other speaker audio unavailable' });
          setSysAudioIssue('waiting');
          scheduleSystemRecoveryRef.current();
        });
      } else {
        // Mono: mic only
        mergerRef.current = null;
        micSource.connect(destination);
        micSource.connect(analyser);
      }

      // Recover silently in the background. Only after the grace period do we
      // surface the compact Retry / Continue choice in the pill.
      scheduleSystemRecoveryRef.current();

      const mr = new MediaRecorder(destination.stream, { mimeType: 'audio/webm;codecs=opus' });
      mediaRef.current = mr;
      chunksRef.current = [];
      savedRawRef.current = null;
      rawAttemptRef.current = undefined;
      stopRetryRef.current = false;
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.start(250);
    } catch (e: any) {
      if (systemMonitorRef.current) clearInterval(systemMonitorRef.current);
      systemMonitorRef.current = null;
      if (systemRecoveryRef.current) clearInterval(systemRecoveryRef.current);
      systemRecoveryRef.current = null;
      if (systemWarningTimerRef.current) clearTimeout(systemWarningTimerRef.current);
      systemWarningTimerRef.current = null;
      systemStreamRef.current?.getTracks().forEach(t => t.stop());
      systemStreamRef.current = null;
      micStreamRef.current?.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
      const msg = `Microphone error: ${e?.name || ''} ${e?.message || String(e)}`.trim();
      reportHealth({ micOk: false, systemAudioOk: false, message: msg });
      setState((s) => ({ ...s, status: 'error', message: msg }));
    }
  };

  const recoverSystemAudio = async (): Promise<boolean> => {
    if (systemIgnoredRef.current) return false;
    const ctx = audioCtxRef.current;
    const destination = destinationRef.current;
    const micSource = micSourceRef.current;
    if (!ctx || !destination || !micSource) return false;
    try {
      const sourceId = await (window as any).inwiseAPI?.getDesktopSourceId?.();
      if (!sourceId) return false;
      try { systemSourceRef.current?.disconnect(); } catch { /* ignore */ }
      systemStreamRef.current?.getTracks().forEach(t => t.stop());
      systemSourceRef.current = null;
      systemStreamRef.current = null;
      const stream: MediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } } as any,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } } as any,
      });
      stream.getVideoTracks().forEach(t => t.stop());

      // If recording began mic-only, replace the mono wiring with the same
      // explicit L/R layout used by normal stereo capture.
      try { micSource.disconnect(); } catch { /* already disconnected */ }
      const hadMerger = !!mergerRef.current;
      const merger = mergerRef.current || ctx.createChannelMerger(2);
      mergerRef.current = merger;
      micSource.connect(merger, 0, 0);
      const source = ctx.createMediaStreamSource(stream);
      source.connect(merger, 0, 1);
      if (!hadMerger) {
        merger.connect(destination);
        if (analyserRef.current) merger.connect(analyserRef.current);
      }
      systemSourceRef.current = source;
      systemStreamRef.current = stream;
      hasStereoRef.current = true;
      setSysAudioIssue('waiting');
      const track = stream.getAudioTracks()[0];
      track?.addEventListener('ended', () => {
        if (!systemIgnoredRef.current) {
          try { (window as any).electronAPI?.sendAudioHealth({ micOk: true, systemAudioOk: false, message: 'Other speaker audio unavailable' }); } catch { /* ignore */ }
          setSysAudioIssue('waiting');
          scheduleSystemRecoveryRef.current();
        }
      });
      track?.addEventListener('mute', () => {
        if (!systemIgnoredRef.current) {
          try { (window as any).electronAPI?.sendAudioHealth({ micOk: true, systemAudioOk: false, message: 'Other speaker audio unavailable' }); } catch { /* ignore */ }
          setSysAudioIssue('waiting');
          scheduleSystemRecoveryRef.current();
        }
      });

      const systemAnalyser = ctx.createAnalyser();
      systemAnalyser.fftSize = 2048;
      source.connect(systemAnalyser);
      const samples = new Float32Array(systemAnalyser.fftSize);
      if (systemMonitorRef.current) clearInterval(systemMonitorRef.current);
      systemMonitorRef.current = setInterval(() => {
        systemAnalyser.getFloatTimeDomainData(samples);
        let sumSq = 0;
        for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
        const rms = Math.sqrt(sumSq / samples.length);
        if (rms > 0.001) {
          setSysAudioIssue('none');
          try { (window as any).electronAPI?.sendAudioHealth({ micOk: true, systemAudioOk: true }); } catch { /* ignore */ }
          if (systemMonitorRef.current) clearInterval(systemMonitorRef.current);
          systemMonitorRef.current = null;
          if (systemRecoveryRef.current) clearInterval(systemRecoveryRef.current);
          systemRecoveryRef.current = null;
          if (systemWarningTimerRef.current) clearTimeout(systemWarningTimerRef.current);
          systemWarningTimerRef.current = null;
        }
      }, 250);
      return true;
    } catch {
      return false;
    }
  };
  recoverSystemAudioRef.current = recoverSystemAudio;

  scheduleSystemRecoveryRef.current = () => {
    if (systemIgnoredRef.current || !audioCtxRef.current) return;
    if (systemRecoveryRef.current) return;
    if (systemWarningTimerRef.current) clearTimeout(systemWarningTimerRef.current);
    systemWarningTimerRef.current = setTimeout(() => {
      systemWarningTimerRef.current = null;
      if (!systemIgnoredRef.current) setSysAudioIssue('unavailable');
    }, 10_000);
    systemRecoveryRef.current = setInterval(() => {
      const track = systemStreamRef.current?.getAudioTracks?.()[0];
      if (track?.readyState === 'live' && !track.muted && sysAudioIssueRef.current !== 'unavailable') return;
      void recoverSystemAudioRef.current().then(ok => {
        if (ok && systemRecoveryRef.current) {
          clearInterval(systemRecoveryRef.current);
          systemRecoveryRef.current = null;
        }
      });
    }, 3_000);
    void recoverSystemAudioRef.current().then(ok => {
      if (ok && systemRecoveryRef.current) {
        clearInterval(systemRecoveryRef.current);
        systemRecoveryRef.current = null;
      }
    });
  };

  const retrySystemAudio = () => {
    systemIgnoredRef.current = false;
    setSysAudioIssue('waiting');
    scheduleSystemRecoveryRef.current();
  };

  const continueWithoutSystemAudio = () => {
    systemIgnoredRef.current = true;
    if (systemRecoveryRef.current) clearInterval(systemRecoveryRef.current);
    if (systemWarningTimerRef.current) clearTimeout(systemWarningTimerRef.current);
    systemRecoveryRef.current = null;
    systemWarningTimerRef.current = null;
    setSysAudioIssue('none');
    try { (window as any).electronAPI?.sendAudioHealth({ micOk: true, systemAudioOk: false, message: 'Recording mic only by request' }); } catch { /* ignore */ }
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
    if (!mr || finalizingRef.current) return;
    finalizingRef.current = true;
    silencePromptRef.current = null;
    setSilencePrompt(null);
    setState(s => ({ ...s, status: 'saving' }));
    let stage = 'capture';
    const details = { title: titleRef.current, calendarEventId: calendarEventIdRef.current, attendees: attendeesRef.current, stereo: hasStereoRef.current, retryId: rawAttemptRef.current };
    try {
      try { await stopVoiceRecorder(mr); }
      finally {
        mr.stream.getTracks().forEach(t => t.stop());
        if (systemMonitorRef.current) clearInterval(systemMonitorRef.current);
        systemMonitorRef.current = null;
        if (systemRecoveryRef.current) clearInterval(systemRecoveryRef.current);
        systemRecoveryRef.current = null;
        if (systemWarningTimerRef.current) clearTimeout(systemWarningTimerRef.current);
        systemWarningTimerRef.current = null;
        try { systemSourceRef.current?.disconnect(); } catch {}
        systemSourceRef.current = null;
        systemStreamRef.current?.getTracks().forEach(t => t.stop());
        systemStreamRef.current = null;
        micStreamRef.current?.getTracks().forEach(t => t.stop());
        micStreamRef.current = null;
        await audioCtxRef.current?.close().catch(() => {});
        audioCtxRef.current = null;
        analyserRef.current = null;
      }
      stage = 'saving';
      const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
      const bytes = await blob.arrayBuffer();
      if (!bytes.byteLength) throw new Error('No audio was captured. Start a new recording and speak for at least a second.');
      if (!savedRawRef.current) {
        const saved = await (window as any).inwiseAPI.saveRecordingCapture(new Uint8Array(bytes), elapsed, blob.type, details);
        rawAttemptRef.current = saved?.meetingId;
        if (!saved?.ok) throw new Error(saved?.error || 'Could not save audio. Keep the recorder open and retry.');
        savedRawRef.current = {id: saved.meetingId, duration: elapsed};
      }
      stage = 'decode';
      const wav = await decodeVoiceRecording(bytes, true);
      (window as any).electronAPI.sendAudio({ buffer: wav, ...details, recoveryId: savedRawRef.current!.id });
      mediaRef.current = null;
      stopRetryRef.current = false;
    } catch (error: any) {
      stopRetryRef.current = true;
      if (!savedRawRef.current && chunksRef.current.length) {
        const partial = new Blob(chunksRef.current, {type: mr.mimeType || 'audio/webm'});
        const saved = await (window as any).inwiseAPI.saveRecordingCapture(new Uint8Array(await partial.arrayBuffer()), elapsed, partial.type, {...details, retryId:rawAttemptRef.current}).catch(() => null);
        rawAttemptRef.current = saved?.meetingId || rawAttemptRef.current;
        if (saved?.ok) savedRawRef.current = {id:saved.meetingId,duration:elapsed};
      }
      if (savedRawRef.current) await (window as any).inwiseAPI.reportRecordingFailure(savedRawRef.current.id, stage === 'capture' ? 'capture' : 'decode').catch(() => {});
      setState(current => ({...current, status:'error', message:savedRawRef.current ? 'Audio saved — processing failed. Retry or open Inwise.' : error?.message || 'Audio could not be saved. Keep the recorder open.'}));
    } finally { finalizingRef.current = false; }
  };

  stopRecordingRef.current = stopRecording;

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

  const respondToSilencePrompt = (response: 'keep' | 'stop') => {
    silencePromptRef.current = null;
    setSilencePrompt(null);
    if (response === 'keep') silenceWatchdogRef.current.reset();
    (window as any).inwiseAPI.respondRecordingSilence?.(response);
  };

  const onPillClick = () => {
    if (silencePrompt) return;
    if (suppressClickRef.current) return;
    if (state.status === 'countdown' || state.status === 'preflight') { cancelCountdown(); return; }
    if (state.status === 'reminder') { window.close(); return; }
    if (state.status === 'saving') {
      (window as any).inwiseAPI.openInwise?.(latestCompletedMeetingRef.current);
      return;
    }
    void runDeviceTest();
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    dragRef.current = { pointerId: e.pointerId, startX: e.screenX, startY: e.screenY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
    (window as any).inwiseAPI.beginPillDrag?.();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (!drag.moved && Math.hypot(e.screenX - drag.startX, e.screenY - drag.startY) < 3) return;
    drag.moved = true;
    (window as any).inwiseAPI.movePill?.();
  };

  const finishPointerDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    (window as any).inwiseAPI.endPillDrag?.();
    if (drag.moved) {
      suppressClickRef.current = true;
      setTimeout(() => { suppressClickRef.current = false; }, 0);
    }
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
      status: statusRef.current,
      title: titleRef.current,
      meetingId: latestCompletedMeetingRef.current,
    });
  };

  // ── Window sizing: pill is left-anchored, so the window grows rightward ──

  const jobList = Object.values(jobs);
  const busyJob = jobList.find(j => j.state === 'transcribing' || j.state === 'processing');
  const errorJob = jobList.find(j => j.state === 'error');
  const doneFlash = !busyJob && !errorJob && jobList.some(j => j.state === 'done');

  const wantWidth = (() => {
    if (silencePrompt && state.status === 'recording') return W_SILENCE_PROMPT;
    if (state.status === 'error') return W_EXPANDED;
    if (test) return W_MEDIUM;
    if (state.status === 'countdown' || state.status === 'preflight') return W_MEDIUM;
    if (state.status === 'reminder') return W_MEDIUM;
    if (state.status === 'recording') return hover ? W_EXPANDED : W_COLLAPSED;
    if (state.status === 'saving') return doneFlash ? W_COMPLETED : hover ? W_EXPANDED : W_COLLAPSED;
    return W_COLLAPSED;
  })();

  useEffect(() => {
    (window as any).inwiseAPI.resizePill?.(wantWidth, PILL_H);
  }, [wantWidth]);

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const truncate = (s: string, n = 30) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  // ── Render pieces ──

  const grip = <div style={styles.grip} title="Drag recorder">⠿</div>;

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

  if (silencePrompt && state.status === 'recording') {
    body = (
      <>
        {grip}
        <span style={{ fontSize: 14, flexShrink: 0 }}>?</span>
        <span style={{ ...styles.label, maxWidth: 120 }}>Are you still there?</span>
        <span style={{ ...styles.subtext, color: AMBER, minWidth: 72 }}>
          auto-save in {silenceSecondsLeft}s
        </span>
        <button
          className="pill-btn"
          onClick={(e) => { e.stopPropagation(); respondToSilencePrompt('keep'); }}
        >
          Keep recording
        </button>
        <button
          className="pill-btn pill-btn-ghost"
          onClick={(e) => { e.stopPropagation(); respondToSilencePrompt('stop'); }}
        >
          Stop &amp; save
        </button>
      </>
    );
  } else if (test) {
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
          p.audio ? TEAL : (sysAudioIssue !== 'none' ? AMBER : DIM),
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
          onClick={(e) => { e.stopPropagation(); if (stopRetryRef.current && chunksRef.current.length) void stopRecording(); else beginFlowRef.current(titleRef.current); }}
        >
          Retry
        </button>
        {savedRawRef.current && <button className="pill-btn pill-btn-ghost" onClick={e => { e.stopPropagation(); (window as any).inwiseAPI.openInwise(savedRawRef.current!.id); }}>Open saved audio</button>}
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
          ? 'Transcription complete — open Inwise from the system tray to see insights'
          : 'Saving…';
    body = (
      <>
        {grip}
        {errorJob ? <StatusDot tone="fail" /> : doneFlash ? <StatusDot tone="ok" /> : <span className="pill-spinner" />}
        <span style={{ ...styles.label, color: errorJob ? '#fca5a5' : doneFlash ? TEAL : '#94a3b8', maxWidth: doneFlash ? 550 : hover ? 300 : 140 }} title={errorJob?.message || label}>
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
        <span style={{ color: '#ecfdf5', display: 'flex', flexShrink: 0 }} title="Inwise recorder">
          <svg width="16" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
          </svg>
        </span>
        {secondaryDot}
        {renderDots(recording
          ? [TEAL, sysAudioIssue !== 'none' ? AMBER : TEAL, TEAL, TEAL]
          : [DIM, DIM, DIM, DIM])}
        {recording && (
          <>
            <span style={styles.label} title={state.title + (sysAudioIssue === 'waiting' ? ' (waiting for call audio)' : sysAudioIssue === 'unavailable' ? ' (mic only)' : '')}>{truncate(state.title)}</span>
            {busyJob && (
              <span style={{ ...styles.subtext, maxWidth: 90 }} title={`Transcribing — ${busyJob.title}`}>
                ⟳ {truncate(busyJob.title, 14)}
              </span>
            )}
            {sysAudioIssue !== 'none' && !busyJob && (
              <span style={{ ...styles.subtext, color: AMBER }}>
                {sysAudioIssue === 'waiting' ? 'waiting for call audio' : 'mic only'}
              </span>
            )}
            {sysAudioIssue === 'unavailable' && (
              <>
                <button
                  className="pill-btn"
                  title="Try to reconnect other-speaker audio"
                  onClick={(e) => { e.stopPropagation(); retrySystemAudio(); }}
                >Retry audio</button>
                <button
                  className="pill-btn pill-btn-ghost"
                  title="Keep recording from the microphone only"
                  onClick={(e) => { e.stopPropagation(); continueWithoutSystemAudio(); }}
                >Continue</button>
              </>
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

  const pillStyle = styles.pill;

  return (
    <div style={styles.wrap}>
      <style>{`
        .pill-root { transition: box-shadow 180ms ease; }
        .pill-root > span { flex-shrink: 1; }
        .recorder-settings { margin-left: auto; border: 0; border-radius: 10px; padding: 8px; color: #ecfdf5; background: rgba(255,255,255,.08); cursor: pointer; display: flex; flex-shrink: 0; }
        .recorder-settings:hover { background: rgba(255,255,255,.2); }
        button:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
        .pill-stop { min-width: 28px; min-height: 28px; }
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
        ref={recorderRef}
        className="pill-root"
        style={pillStyle}
        onClick={onPillClick}
        onContextMenu={onContextMenu}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointerDrag}
        onPointerCancel={finishPointerDrag}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {body}
        <button className="recorder-settings" aria-label="Expand to Inwise" title="Open Inwise"
          onClick={(e) => { e.stopPropagation(); (window as any).inwiseAPI.openInwise?.(); }}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
          </svg>
        </button>
        <button className="recorder-settings" style={{ marginLeft: 0 }} aria-label="Recorder settings and audio devices" title="Recorder settings and audio devices"
          onClick={(e) => { e.stopPropagation(); void onContextMenu(e); }}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 3-1 2 2 3-1 1-3 3-1 2-3-2-2 1-3-3-2-3 1-2-2Z" />
            <circle cx="12" cy="11" r="3" />
          </svg>
        </button>
      </div>
    </div>
  );
}
