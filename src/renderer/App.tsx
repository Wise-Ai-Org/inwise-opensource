import React, { useState, useEffect } from 'react';
import Onboarding from './Onboarding';
import Sidebar from './Sidebar';
import Communications from './Communications';
import People from './People';
import MyTasks from './MyTasks';
import Settings from './Settings';

type View = 'communications' | 'tasks' | 'people' | 'settings';

export default function App() {
  const [ready, setReady] = useState(false);
  const [onboarded, setOnboarded] = useState(false);
  const [view, setView] = useState<View>('communications');

  useEffect(() => {
    (window as any).inwiseAPI.getConfig().then((cfg: any) => {
      setOnboarded(cfg.onboardingComplete && cfg.apiKey !== '');
      setReady(true);
    });
  }, []);

  if (!ready) return null;
  if (!onboarded) return <Onboarding onComplete={() => setOnboarded(true)} />;

  return (
    <div className="app-layout">
      <Sidebar activeView={view} onNavigate={setView} />
      <div className="main-content">
        {view === 'communications' && <Communications />}
        {view === 'tasks'          && <MyTasks />}
        {view === 'people'         && <People />}
        {view === 'settings'       && <Settings />}
      </div>
    </div>
  );
}
