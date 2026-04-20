import React, { useState, useEffect, useCallback } from 'react';

type View = 'communications' | 'tasks' | 'people' | 'settings';

interface Step {
  targetSelector: string;
  title: string;
  description: string;
  navigateTo: View;
}

const STEPS: Step[] = [
  {
    targetSelector: '.record-btn',
    title: 'Record a Meeting',
    description: 'Click here to start recording. Inwise captures your mic and system audio — so both sides of the call are transcribed.',
    navigateTo: 'communications',
  },
  {
    targetSelector: '.meeting-card',
    title: 'Review AI Insights',
    description: 'Recorded meetings appear here in your Communication Center. Click any meeting to review the action items, decisions, and commitments that Inwise extracted.',
    navigateTo: 'communications',
  },
  {
    targetSelector: '[data-nav="tasks"]',
    title: 'Your Tasks, Prioritized',
    description: 'Action items you approve from meetings flow here as tasks. Inwise scores and prioritizes them automatically — review, re-order, or approve pending items anytime.',
    navigateTo: 'tasks',
  },
  {
    targetSelector: '[data-nav="people"]',
    title: 'Track Your People',
    description: 'Inwise builds a profile for everyone you meet — meeting history, open action items, commitments, and nudges when things go stale.',
    navigateTo: 'people',
  },
  {
    targetSelector: '[data-nav="settings"]',
    title: 'Connect Your Calendar',
    description: 'Add your Google or Outlook calendar link in Settings. Inwise auto-detects upcoming meetings and prompts you to record.',
    navigateTo: 'settings',
  },
  {
    targetSelector: '.sidebar-record',
    title: 'Search Across Meetings',
    description: 'Ask anything about your meetings. Inwise searches across all your meeting history and gives you AI-synthesized answers.',
    navigateTo: 'communications',
  },
];

interface Props {
  onNavigate: (view: View) => void;
  onComplete: () => void;
}

export default function FirstTimeUserFlow({ onNavigate, onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [spotlight, setSpotlight] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [ready, setReady] = useState(false);

  const positionSpotlight = useCallback(() => {
    const s = STEPS[step];
    if (!s) return;
    const el = document.querySelector(s.targetSelector);
    if (el) {
      const rect = el.getBoundingClientRect();
      setSpotlight({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        w: rect.width,
        h: rect.height,
      });
      setReady(true);
    } else {
      // Element not found yet — might need a moment after navigation
      setSpotlight(null);
      setReady(true);
    }
  }, [step]);

  useEffect(() => {
    const s = STEPS[step];
    if (!s) return;
    onNavigate(s.navigateTo);
    // Give the view time to render before looking for the target element
    const timer = setTimeout(positionSpotlight, 400);
    return () => clearTimeout(timer);
  }, [step, onNavigate, positionSpotlight]);

  // Reposition on resize
  useEffect(() => {
    window.addEventListener('resize', positionSpotlight);
    return () => window.removeEventListener('resize', positionSpotlight);
  }, [positionSpotlight]);

  const handleNext = () => {
    if (step < STEPS.length - 1) {
      setReady(false);
      setStep(step + 1);
    } else {
      onComplete();
    }
  };

  const handleSkip = () => {
    onComplete();
  };

  if (!ready) return null;

  const current = STEPS[step];
  const spotlightRadius = spotlight ? Math.max(spotlight.w, spotlight.h) * 0.7 + 20 : 80;

  // Position the text card: prefer below the spotlight, or above if too close to bottom
  const cardTop = spotlight
    ? (spotlight.y + spotlightRadius + 30 > window.innerHeight - 200
        ? Math.max(20, spotlight.y - spotlightRadius - 200)
        : spotlight.y + spotlightRadius + 30)
    : window.innerHeight / 2 - 100;

  const cardLeft = spotlight
    ? Math.min(Math.max(20, spotlight.x - 160), window.innerWidth - 360)
    : window.innerWidth / 2 - 160;

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 10000,
      pointerEvents: 'auto',
    }}>
      {/* Dark overlay with spotlight cutout */}
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
        <defs>
          <mask id="spotlight-mask">
            <rect width="100%" height="100%" fill="white" />
            {spotlight && (
              <circle
                cx={spotlight.x}
                cy={spotlight.y}
                r={spotlightRadius}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="rgba(15, 23, 42, 0.75)"
          mask="url(#spotlight-mask)"
        />
        {/* Spotlight ring */}
        {spotlight && (
          <circle
            cx={spotlight.x}
            cy={spotlight.y}
            r={spotlightRadius}
            fill="none"
            stroke="rgba(13, 148, 136, 0.3)"
            strokeWidth="3"
          />
        )}
      </svg>

      {/* Content card */}
      <div style={{
        position: 'absolute',
        top: cardTop,
        left: cardLeft,
        width: 320,
        background: '#fff',
        borderRadius: 16,
        padding: '24px 24px 20px',
        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.25)',
        zIndex: 10001,
      }}>
        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
          {STEPS.map((_, i) => (
            <div
              key={i}
              style={{
                width: i === step ? 24 : 8,
                height: 8,
                borderRadius: 4,
                background: i === step ? '#0d9488' : i < step ? '#99f6e4' : '#e2e8f0',
                transition: 'all 0.3s',
              }}
            />
          ))}
        </div>

        <h3 style={{
          fontSize: 20,
          fontWeight: 700,
          color: '#0f172a',
          marginBottom: 8,
          lineHeight: 1.3,
        }}>
          {current.title}
        </h3>

        <p style={{
          fontSize: 14,
          color: '#64748b',
          lineHeight: 1.6,
          marginBottom: 20,
        }}>
          {current.description}
        </p>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button
            onClick={handleSkip}
            style={{
              background: 'none',
              border: 'none',
              color: '#94a3b8',
              fontSize: 13,
              cursor: 'pointer',
              padding: '4px 8px',
            }}
          >
            Skip tour
          </button>

          <button
            onClick={handleNext}
            style={{
              background: '#0d9488',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '8px 20px',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = '#14b8a6')}
            onMouseLeave={e => (e.currentTarget.style.background = '#0d9488')}
          >
            {step < STEPS.length - 1 ? 'Next' : 'Got it!'}
          </button>
        </div>
      </div>
    </div>
  );
}
