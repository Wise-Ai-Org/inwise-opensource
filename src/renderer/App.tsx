import React, { useState, useEffect, useRef } from 'react';
import Onboarding from './Onboarding';
import PopupShell from './popup/PopupShell';
import { requestPopupNav, LegacyView } from './popup/nav';
import WelcomeBack from './WelcomeBack';
import { LiveMeetingInfo } from './LiveMeetingBanner';
import MeetingConflictModal, { ConflictMeeting } from './components/modal/MeetingConflictModal';
import { startAudioCapture, stopAudioCapture, on as onAudioCapture, SILENCE_STOP_MS } from './audio-capture';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string | null }
> {
  constructor(props: any) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(err: any) {
    return { error: err?.message || String(err) };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, color: '#ef4444', fontFamily: 'monospace', fontSize: 13 }}>
          <strong>Render error:</strong>
          <pre style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{this.state.error}</pre>
          <button style={{ marginTop: 16 }} onClick={() => this.setState({ error: null })}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [onboarded, setOnboarded] = useState(false);
  const [conflict, setConflict] = useState<
    | { active: ConflictMeeting; incoming: ConflictMeeting; autoSelectMs: number }
    | null
  >(null);
  const [welcomeBackVisible, setWelcomeBackVisible] = useState(true);
  const [liveMeetingChecked, setLiveMeetingChecked] = useState(false);
  const [liveMeetingSuppressesWelcomeBack, setLiveMeetingSuppressesWelcomeBack] = useState(false);

  useEffect(() => {
    const api = (window as any).inwiseAPI;
    if (!api?.welcomeBackLiveMeeting) {
      setLiveMeetingChecked(true);
      return;
    }
    api.welcomeBackLiveMeeting()
      .then((m: LiveMeetingInfo | null) => {
        // The live-meeting banner itself renders inside MeetingsTab; here it
        // only suppresses the welcome-back overlay.
        if (m) setLiveMeetingSuppressesWelcomeBack(true);
      })
      .catch(() => { /* fail open — welcome-back renders normally */ })
      .finally(() => setLiveMeetingChecked(true));
  }, []);

  useEffect(() => {
    (window as any).inwiseAPI.getConfig().then((cfg: any) => {
      setOnboarded(cfg.onboardingComplete && cfg.apiKey !== '');
      setReady(true);
    });
  }, []);

  // Calendar-free recording: when enabled, an always-on Silero VAD listens to the
  // mic and drives the existing Badge recording pipeline — start on detected speech,
  // stop after SILENCE_STOP_MS of silence — with no calendar event required.
  useEffect(() => {
    const api = (window as any).inwiseAPI;
    let cancelled = false;
    let recordingActive = false;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanups: Array<() => void> = [];

    api.getConfig().then((cfg: any) => {
      if (cancelled || !cfg?.calendarFreeRecording) return;

      // Re-arm when a recording fully completes or errors. Without this,
      // recordingActive stays true after the first recording (pipeline done or
      // user-stopped) and every later speech detection is swallowed by the guard
      // below — making the always-on VAD look dead until app restart.
      const onStatus = (payload: { status?: string }) => {
        if (payload?.status === 'done' || payload?.status === 'error') {
          recordingActive = false;
          if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
          console.log('[CFR] recording ' + payload.status + ' -> re-armed');
        }
      };
      api.on?.('recording:status', onStatus);
      cleanups.push(() => api.off?.('recording:status', onStatus));

      cleanups.push(onAudioCapture('speech-start', () => {
        if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
        console.log('[CFR] speech-start; recordingActive=', recordingActive);
        if (!recordingActive) {
          recordingActive = true;
          api.startRecording?.('Recorded conversation');
        }
      }));

      cleanups.push(onAudioCapture('speech-end', () => {
        if (silenceTimer) clearTimeout(silenceTimer);
        // Stop after SILENCE_STOP_MS of continuous silence. recordingActive is
        // reset by the recording:status handler above (not here), so we never
        // re-arm before the pipeline has actually finished processing.
        silenceTimer = setTimeout(() => {
          console.log('[CFR] silence timeout -> stopRecording');
          api.stopRecording?.();
        }, SILENCE_STOP_MS);
      }));

      startAudioCapture().catch((e: unknown) =>
        console.error('[CalendarFreeRecording] failed to start VAD', e));
    });

    return () => {
      cancelled = true;
      if (silenceTimer) clearTimeout(silenceTimer);
      cleanups.forEach(fn => fn());
      stopAudioCapture().catch(() => { /* ignore */ });
    };
  }, []);

  useEffect(() => {
    const api = (window as any).inwiseAPI;
    if (!api?.on) return;
    const onConflict = (payload: { active: ConflictMeeting; incoming: ConflictMeeting; autoSelectMs: number }) => {
      if (!payload?.active || !payload?.incoming) return;
      setConflict(payload);
    };
    const onResolved = () => setConflict(null);
    const onOpenDetails = (payload: { meetingId: string; focusTab?: string }) => {
      if (!payload?.meetingId) return;
      requestPopupNav({ meetingId: payload.meetingId });
    };
    // Pill context menu's "Settings" (and future deep links) land here.
    const onNavigate = (target: string) => {
      if (target) requestPopupNav({ view: target as LegacyView });
    };
    api.on('meeting:conflict', onConflict);
    api.on('meeting:conflict:resolved', onResolved);
    api.on('meeting:open-details', onOpenDetails);
    api.on('app:navigate', onNavigate);
    return () => {
      api.off?.('meeting:conflict', onConflict);
      api.off?.('meeting:conflict:resolved', onResolved);
      api.off?.('meeting:open-details', onOpenDetails);
      api.off?.('app:navigate', onNavigate);
    };
  }, []);

  const handlePickConflict = (chosenId: string) => {
    (window as any).inwiseAPI.chooseMeetingForConflict?.(chosenId);
    // Close optimistically; main will also emit meeting:conflict:resolved.
    setConflict(null);
  };

  const navigate = (view: LegacyView) => requestPopupNav({ view });

  if (!ready) return null;
  if (!onboarded) return (
    <Onboarding
      onComplete={async () => {
        setWelcomeBackVisible(false);
        await (window as any).inwiseAPI?.completeOnboardingTransition?.();
        setOnboarded(true);
      }}
    />
  );

  return (
    <>
      <ErrorBoundary>
        <PopupShell />
      </ErrorBoundary>
      {welcomeBackVisible && liveMeetingChecked && !liveMeetingSuppressesWelcomeBack && (
        <WelcomeBack
          onNavigate={navigate}
          onDismiss={() => setWelcomeBackVisible(false)}
        />
      )}
      <MeetingConflictModal
        isOpen={!!conflict}
        active={conflict?.active ?? null}
        incoming={conflict?.incoming ?? null}
        autoSelectMs={conflict?.autoSelectMs ?? 30000}
        onPick={handlePickConflict}
      />
    </>
  );
}
