import React, { useEffect, useState } from 'react';

/** Payload shape returned by the dailyPlan:get IPC (see main.ts). */
interface PlanMeeting {
  id: string;
  title: string;
  startTime: number;
  endTime: number;
  attendees: string[];
  agenda: string[];
}

interface PlanTask {
  id: string;
  title: string;
  priority: string;
  dueDate: string | null;
  reasoning: string;
}

interface Plan {
  greeting: { title: string; sub: string };
  meetings: PlanMeeting[];
  tasks: PlanTask[];
  hasApiKey: boolean;
}

const TEAL = '#0d9488';
const TEAL_TINT = '#f0fdfa';
const TEAL_LINE = '#99f6e4';
const SLATE_900 = '#0f172a';
const SLATE_600 = '#475569';
const SLATE_500 = '#64748b';
const SLATE_200 = '#e2e8f0';

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const PRIORITY_COLOR: Record<string, string> = {
  critical: '#dc2626',
  high: '#ea580c',
  medium: TEAL,
  low: SLATE_500,
};

export default function DailyPlan(): JSX.Element {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    (window as any).inwiseDailyPlan
      .getPlan()
      .then((p: Plan) => setPlan(p))
      .catch(() => setFailed(true));
  }, []);

  const api = (window as any).inwiseDailyPlan;

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: '#ffffff',
        borderRadius: 16,
        border: `1px solid ${SLATE_200}`,
        boxShadow: '0 12px 40px rgba(15, 23, 42, 0.18)',
        overflow: 'hidden',
      }}
    >
      {/* Header — draggable strip */}
      <div
        style={{
          padding: '16px 18px 12px',
          background: TEAL_TINT,
          borderBottom: `1px solid ${TEAL_LINE}`,
          WebkitAppRegion: 'drag',
          position: 'relative',
        } as React.CSSProperties}
      >
        <button
          onClick={() => api.dismiss()}
          title="Dismiss"
          style={{
            WebkitAppRegion: 'no-drag',
            position: 'absolute',
            top: 10,
            right: 10,
            width: 24,
            height: 24,
            border: 'none',
            background: 'transparent',
            color: SLATE_500,
            fontSize: 16,
            lineHeight: '24px',
            cursor: 'pointer',
            borderRadius: 6,
          } as React.CSSProperties}
        >
          ×
        </button>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: TEAL, textTransform: 'uppercase', marginBottom: 4 }}>
          Wiser planned your day
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, color: SLATE_900 }}>
          {plan ? plan.greeting.title : 'One moment'}
        </div>
        <div style={{ fontSize: 12.5, color: SLATE_600, marginTop: 2 }}>
          {failed
            ? 'Wiser tripped over a wire fetching your plan. Open Inwise to see today.'
            : plan
              ? plan.greeting.sub
              : 'Wiser is putting your plan together…'}
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px' }}>
        {plan && (
          <>
            <SectionTitle>Today's meetings</SectionTitle>
            {plan.meetings.length === 0 && (
              <div style={{ fontSize: 13, color: SLATE_500, marginBottom: 14 }}>
                Nothing on the calendar — a clear runway for deep work.
              </div>
            )}
            {plan.meetings.map((m) => (
              <div key={m.id} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: TEAL, whiteSpace: 'nowrap' }}>
                    {fmtTime(m.startTime)}
                  </span>
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: SLATE_900 }}>{m.title}</span>
                </div>
                {m.agenda.length > 0 && (
                  <div
                    style={{
                      marginTop: 6,
                      marginLeft: 2,
                      padding: '8px 10px',
                      background: TEAL_TINT,
                      border: `1px solid ${TEAL_LINE}`,
                      borderRadius: 8,
                    }}
                  >
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: TEAL, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 4 }}>
                      Wiser's draft agenda
                    </div>
                    {m.agenda.map((item, i) => (
                      <div key={i} style={{ fontSize: 12.5, color: SLATE_600, display: 'flex', gap: 6, marginBottom: 2 }}>
                        <span style={{ color: TEAL }}>•</span>
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}

            <SectionTitle style={{ marginTop: 18 }}>Top priorities</SectionTitle>
            {plan.tasks.length === 0 && (
              <div style={{ fontSize: 13, color: SLATE_500 }}>
                No open tasks — Wiser is as surprised as you are.
              </div>
            )}
            {plan.tasks.map((t, i) => (
              <div key={t.id} style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                <div
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    background: TEAL_TINT,
                    border: `1px solid ${TEAL_LINE}`,
                    color: TEAL,
                    fontSize: 11,
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    marginTop: 1,
                  }}
                >
                  {i + 1}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: SLATE_900 }}>
                    {t.title}
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 10.5,
                        fontWeight: 700,
                        color: PRIORITY_COLOR[t.priority] || SLATE_500,
                        textTransform: 'uppercase',
                        letterSpacing: 0.4,
                      }}
                    >
                      {t.priority}
                    </span>
                  </div>
                  {t.reasoning && (
                    <div style={{ fontSize: 12, color: SLATE_500, marginTop: 1 }}>{t.reasoning}</div>
                  )}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Footer */}
      <div
        style={{
          display: 'flex',
          gap: 10,
          padding: '12px 18px 16px',
          borderTop: `1px solid ${SLATE_200}`,
        }}
      >
        <button
          onClick={() => api.openInwise()}
          style={{
            flex: 1,
            padding: '9px 0',
            background: TEAL,
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Open Inwise
        </button>
        <button
          onClick={() => api.dismiss()}
          style={{
            padding: '9px 16px',
            background: 'transparent',
            color: SLATE_600,
            border: `1px solid ${SLATE_200}`,
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Got it
        </button>
      </div>
    </div>
  );
}

function SectionTitle({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }): JSX.Element {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.8,
        color: SLATE_500,
        textTransform: 'uppercase',
        marginBottom: 8,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
