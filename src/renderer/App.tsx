import React, { useState, useEffect } from 'react';
import Onboarding from './Onboarding';
import Sidebar from './Sidebar';
import Communications from './Communications';
import People from './People';
import MyTasks from './MyTasks';
import Settings from './Settings';
import FirstTimeUserFlow from './FirstTimeUserFlow';
import WelcomeBack from './WelcomeBack';
import MeetingConflictModal, { ConflictMeeting } from './components/modal/MeetingConflictModal';

type View = 'communications' | 'tasks' | 'people' | 'settings';

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
  const [showFirstTimeFlow, setShowFirstTimeFlow] = useState(false);
  const [view, setView] = useState<View>('communications');
  const [conflict, setConflict] = useState<
    | { active: ConflictMeeting; incoming: ConflictMeeting; autoSelectMs: number }
    | null
  >(null);
  const [welcomeBackVisible, setWelcomeBackVisible] = useState(true);

  useEffect(() => {
    (window as any).inwiseAPI.getConfig().then((cfg: any) => {
      setOnboarded(cfg.onboardingComplete && cfg.apiKey !== '');
      // Show first time flow if onboarded but seen fewer than 5 times
      if (cfg.onboardingComplete && cfg.apiKey !== '' && (cfg.firstTimeFlowCount || 0) < 5) {
        setShowFirstTimeFlow(true);
        // Increment the count
        (window as any).inwiseAPI.setConfig({
          firstTimeFlowCount: (cfg.firstTimeFlowCount || 0) + 1,
        });
      }
      setReady(true);
    });
  }, []);

  useEffect(() => {
    const api = (window as any).inwiseAPI;
    if (!api?.on) return;
    const onConflict = (payload: { active: ConflictMeeting; incoming: ConflictMeeting; autoSelectMs: number }) => {
      if (!payload?.active || !payload?.incoming) return;
      setConflict(payload);
    };
    const onResolved = () => setConflict(null);
    api.on('meeting:conflict', onConflict);
    api.on('meeting:conflict:resolved', onResolved);
    return () => {
      api.off?.('meeting:conflict', onConflict);
      api.off?.('meeting:conflict:resolved', onResolved);
    };
  }, []);

  const handlePickConflict = (chosenId: string) => {
    (window as any).inwiseAPI.chooseMeetingForConflict?.(chosenId);
    // Close optimistically; main will also emit meeting:conflict:resolved.
    setConflict(null);
  };

  const handleFirstTimeFlowComplete = () => {
    setShowFirstTimeFlow(false);
  };

  if (!ready) return null;
  if (!onboarded) return <Onboarding onComplete={() => { setOnboarded(true); setShowFirstTimeFlow(true); }} />;

  return (
    <div className="app-layout">
      <Sidebar activeView={view} onNavigate={setView} />
      <div className="main-content">
        <ErrorBoundary>
          {view === 'communications' && <Communications />}
          {view === 'tasks'          && <MyTasks onNavigate={(v: string) => setView(v as View)} />}
          {view === 'people'         && <People />}
          {view === 'settings'       && <Settings />}
        </ErrorBoundary>
      </div>
      {showFirstTimeFlow && (
        <FirstTimeUserFlow
          onNavigate={setView}
          onComplete={handleFirstTimeFlowComplete}
        />
      )}
      {welcomeBackVisible && !showFirstTimeFlow && (
        <WelcomeBack
          onNavigate={setView}
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
    </div>
  );
}
