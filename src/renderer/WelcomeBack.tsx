import React, { useCallback, useEffect, useState } from 'react';

type View = 'communications' | 'tasks' | 'people' | 'settings';

interface WelcomeBackWins {
  cleared?: { count: number; sampleTitles: string[] };
  jiraProgress?: { count: number; doneCount: number };
  meetingsMatched?: { count: number };
  calendarHealthy?: { upcomingCount: number };
}

type WelcomeBackAskKind = 'contradiction' | 'overdueWithSignal' | 'launchAtStartupOffer';

interface WelcomeBackAsk {
  kind: WelcomeBackAskKind;
  payload: any;
}

interface WelcomeBackResult {
  gapDays: number;
  wins: WelcomeBackWins;
  ask?: WelcomeBackAsk;
}

interface Props {
  onNavigate: (view: View) => void;
  onDismiss: () => void;
}

const TEAL = '#0d9488';
const TEAL_HOVER = '#14b8a6';
const INK = '#0f172a';
const MUTED = '#64748b';
const BORDER = '#e2e8f0';
const PAGE_BG = 'rgba(15, 23, 42, 0.55)';
const CARD_BG = '#ffffff';

function greeting(gapDays: number): string {
  if (gapDays >= 14) return 'Welcome back — it\'s been a while';
  if (gapDays >= 7) return 'Welcome back';
  return 'Welcome back';
}

function WinLine({ text }: { text: string }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      padding: '10px 0',
      borderBottom: `1px solid ${BORDER}`,
      fontSize: 14,
      color: INK,
      lineHeight: 1.5,
    }}>
      <span aria-hidden style={{ color: TEAL, marginTop: 2, fontSize: 16, lineHeight: 1 }}>✓</span>
      <span>{text}</span>
    </div>
  );
}

function PrimaryButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: TEAL,
        color: '#fff',
        border: 'none',
        borderRadius: 8,
        padding: '8px 18px',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        transition: 'background 0.15s',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = TEAL_HOVER)}
      onMouseLeave={e => (e.currentTarget.style.background = TEAL)}
    >
      {children}
    </button>
  );
}

function GhostButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'transparent',
        color: MUTED,
        border: `1px solid ${BORDER}`,
        borderRadius: 8,
        padding: '8px 14px',
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function LaunchAtStartupCard({ onLocalDismiss }: { onLocalDismiss: () => void }) {
  const [state, setState] = useState<'offer' | 'enabling' | 'enabled' | 'failed'>('offer');

  const handleTurnOn = useCallback(async () => {
    setState('enabling');
    try {
      const api = (window as any).inwiseAPI;
      const res = await api?.setLoginItemOpenAtLogin?.(true);
      if (res && res.ok) {
        setState('enabled');
      } else {
        setState('failed');
      }
    } catch {
      setState('failed');
    }
  }, []);

  if (state === 'enabled') {
    return (
      <div style={askCardStyle} data-testid="welcome-back-ask-launch-confirmed">
        <div style={{ ...askBodyStyle, marginBottom: 0 }}>
          Done. Inwise will start automatically next time you log in.
        </div>
      </div>
    );
  }

  return (
    <div style={askCardStyle} data-testid="welcome-back-ask-launch">
      <div style={askLeadStyle}>Want Inwise to start automatically when you log in?</div>
      <div style={askBodyStyle}>You missed a few meetings while it was closed.</div>
      {state === 'failed' && (
        <div style={{ ...askBodyStyle, color: '#b91c1c', marginBottom: 12 }}>
          Couldn't change that setting. You can toggle it from your OS login items.
        </div>
      )}
      <div style={askActionsStyle}>
        <PrimaryButton onClick={handleTurnOn}>
          {state === 'enabling' ? 'Turning on…' : 'Turn on'}
        </PrimaryButton>
        <GhostButton onClick={onLocalDismiss}>Not now</GhostButton>
      </div>
    </div>
  );
}

function AskCard({
  ask,
  onLocalDismiss,
  onNavigate,
  onDone,
}: {
  ask: WelcomeBackAsk;
  onLocalDismiss: () => void;
  onNavigate: (view: View) => void;
  onDone: () => void;
}) {
  if (ask.kind === 'contradiction') {
    const summary = ask.payload?.summary || 'A recent decision may conflict with an earlier one.';
    return (
      <div style={askCardStyle} data-testid="welcome-back-ask-contradiction">
        <div style={askLeadStyle}>One thing worth a look.</div>
        <div style={askBodyStyle}>{summary}</div>
        <div style={askActionsStyle}>
          <PrimaryButton onClick={() => { onDone(); onNavigate('communications'); }}>Review</PrimaryButton>
          <GhostButton onClick={onLocalDismiss}>Dismiss</GhostButton>
        </div>
      </div>
    );
  }
  if (ask.kind === 'overdueWithSignal') {
    const title = ask.payload?.title || '(untitled task)';
    return (
      <div style={askCardStyle} data-testid="welcome-back-ask-overdue">
        <div style={askLeadStyle}>One task is past due and you've mentioned it recently:</div>
        <div style={{ ...askBodyStyle, fontWeight: 600 }}>{title}</div>
        <div style={askActionsStyle}>
          <PrimaryButton onClick={onLocalDismiss}>Snooze to next week</PrimaryButton>
          <GhostButton onClick={onLocalDismiss}>Mark done</GhostButton>
          <GhostButton onClick={onLocalDismiss}>Keep as-is</GhostButton>
        </div>
      </div>
    );
  }
  if (ask.kind === 'launchAtStartupOffer') {
    return <LaunchAtStartupCard onLocalDismiss={onLocalDismiss} />;
  }
  return null;
}

const askCardStyle: React.CSSProperties = {
  marginTop: 18,
  padding: 16,
  background: '#f8fafc',
  border: `1px solid ${BORDER}`,
  borderRadius: 12,
};

const askLeadStyle: React.CSSProperties = {
  fontSize: 13,
  color: MUTED,
  marginBottom: 6,
};

const askBodyStyle: React.CSSProperties = {
  fontSize: 14,
  color: INK,
  marginBottom: 12,
  lineHeight: 1.5,
};

const askActionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
};

const CHIP_TARGETS: { label: string; view: View }[] = [
  { label: 'Tasks', view: 'tasks' },
  { label: 'Meetings', view: 'communications' },
  { label: 'Jira', view: 'settings' },
  { label: 'Calendar', view: 'settings' },
];

export default function WelcomeBack({ onNavigate, onDismiss }: Props) {
  const [phase, setPhase] = useState<'loading' | 'hidden' | 'shown'>('loading');
  const [result, setResult] = useState<WelcomeBackResult | null>(null);
  const [askDismissed, setAskDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const api = (window as any).inwiseAPI;
    if (!api?.welcomeBackCompute) {
      setPhase('hidden');
      onDismiss();
      return;
    }
    (async () => {
      try {
        const r: WelcomeBackResult | null = await api.welcomeBackCompute();
        if (cancelled) return;
        if (!r) {
          setPhase('hidden');
          onDismiss();
          return;
        }
        setResult(r);
        setPhase('shown');
      } catch {
        if (cancelled) return;
        setPhase('hidden');
        onDismiss();
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDone = useCallback(async () => {
    try {
      await (window as any).inwiseAPI?.welcomeBackDismiss?.();
    } catch {
      // never let dismiss persistence failure block the UI
    }
    onDismiss();
  }, [onDismiss]);

  if (phase !== 'shown' || !result) return null;

  const { wins, ask } = result;
  const hasWins = !!(wins.cleared || wins.jiraProgress || wins.meetingsMatched || wins.calendarHealthy);
  const renderedAsk = ask && !askDismissed ? ask : null;

  return (
    <div
      data-testid="welcome-back-screen"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9500,
        background: PAGE_BG,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 560,
          background: CARD_BG,
          borderRadius: 16,
          boxShadow: '0 12px 40px rgba(0, 0, 0, 0.25)',
          padding: '28px 28px 24px',
          position: 'relative',
        }}
      >
        <button
          data-testid="welcome-back-done"
          onClick={handleDone}
          style={{
            position: 'absolute',
            top: 14,
            right: 14,
            background: 'transparent',
            color: MUTED,
            border: `1px solid ${BORDER}`,
            borderRadius: 8,
            padding: '4px 12px',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Done
        </button>

        <h2 style={{ fontSize: 20, fontWeight: 700, color: INK, margin: 0, marginBottom: 4 }}>
          {greeting(result.gapDays)}
        </h2>
        <div style={{ fontSize: 13, color: MUTED, marginBottom: 16 }}>
          Here's what happened while you were away.
        </div>

        {hasWins ? (
          <div style={{ borderTop: `1px solid ${BORDER}` }}>
            {wins.cleared && (
              <WinLine
                text={`Cleared ${wins.cleared.count} task${wins.cleared.count === 1 ? '' : 's'} you hadn't touched recently (bring any back anytime)`}
              />
            )}
            {wins.jiraProgress && (
              <WinLine
                text={`${wins.jiraProgress.count} Jira ${wins.jiraProgress.count === 1 ? 'story' : 'stories'} moved forward while you were out — ${wins.jiraProgress.doneCount} ${wins.jiraProgress.doneCount === 1 ? 'is' : 'are'} now Done`}
              />
            )}
            {wins.meetingsMatched && (
              <WinLine
                text={`Matched ${wins.meetingsMatched.count} new meeting${wins.meetingsMatched.count === 1 ? '' : 's'} to Jira issues automatically`}
              />
            )}
            {wins.calendarHealthy && (
              <WinLine
                text={`Calendar in sync; ${wins.calendarHealthy.upcomingCount} upcoming this week`}
              />
            )}
          </div>
        ) : (
          !renderedAsk && (
            <div
              data-testid="welcome-back-empty"
              style={{
                fontSize: 14,
                color: INK,
                padding: '16px 0',
                borderTop: `1px solid ${BORDER}`,
                borderBottom: `1px solid ${BORDER}`,
                lineHeight: 1.5,
              }}
            >
              Nothing urgent while you were out — everything's where you left it.
            </div>
          )
        )}

        {renderedAsk && (
          <AskCard
            ask={renderedAsk}
            onLocalDismiss={() => setAskDismissed(true)}
            onNavigate={onNavigate}
            onDone={handleDone}
          />
        )}

        <div
          style={{
            marginTop: 22,
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          {CHIP_TARGETS.map(c => (
            <button
              key={c.label}
              data-testid={`welcome-back-chip-${c.label.toLowerCase()}`}
              onClick={() => { handleDone(); onNavigate(c.view); }}
              style={{
                background: '#f1f5f9',
                color: INK,
                border: `1px solid ${BORDER}`,
                borderRadius: 999,
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = '#e2e8f0')}
              onMouseLeave={e => (e.currentTarget.style.background = '#f1f5f9')}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
