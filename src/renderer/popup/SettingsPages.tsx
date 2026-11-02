import React, { useEffect, useRef, useState } from 'react';
import { api, useNav, SettingsSectionKey } from './nav';
import Settings from '../Settings';
import type { NotificationSettings } from '../api';
import './ollie.css';

const SECTIONS: Array<{ key: SettingsSectionKey | 'integrations-hub'; icon: string; label: string }> = [
  { key: 'ai', icon: '✦', label: 'AI provider' },
  { key: 'startup', icon: '▸', label: 'Startup & daily plan' },
  { key: 'notifications', icon: '◔', label: 'Notifications' },
  { key: 'transcription', icon: '◉', label: 'Transcription & recording' },
  { key: 'integrations-hub', icon: '⚏', label: 'Integrations' },
  { key: 'ai-connect', icon: '⌘', label: 'Connect to AI' },
  { key: 'voice', icon: '☺', label: 'Voice & identity' },
  { key: 'data', icon: '▤', label: 'Data' },
];

// Rows shown inside the "Integrations" hub — connection status for each
// service plus the approval-gates/sync settings, all in one place instead of
// separate top-level Settings rows.
const INTEGRATION_ROWS: Array<{ key: SettingsSectionKey; icon: string; label: string }> = [
  { key: 'calendar', icon: '▦', label: 'Calendar' },
  { key: 'jira', icon: '⇄', label: 'Jira' },
  { key: 'slack', icon: '#', label: 'Slack' },
  { key: 'zoom', icon: '◎', label: 'Zoom' },
  { key: 'teams', icon: 'T', label: 'Microsoft Teams' },
  { key: 'meet', icon: 'M', label: 'Google Meet' },
  { key: 'integrations', icon: '⚙', label: 'Approval gates & sync' },
];

async function fetchIntegrationStatuses(): Promise<Record<string, string>> {
  const a = api();
  const [cals, jira, slack, zoom, teams, meet] = await Promise.allSettled([
    a.listCalendars?.(),
    a.jiraStatus?.(),
    a.slackStatus?.(),
    a.zoomStatus?.(),
    a.teamsStatus?.(),
    a.meetStatus?.(),
  ]);
  const next: Record<string, string> = {};
  if (cals.status === 'fulfilled' && Array.isArray(cals.value)) {
    const n = cals.value.filter((c: any) => c.enabled !== false).length;
    next['calendar'] = n > 0 ? `${n} calendar${n === 1 ? '' : 's'} connected` : 'Not connected';
  }
  const connLabel = (r: PromiseSettledResult<any>) =>
    r.status === 'fulfilled' && (r.value?.connected || r.value?.isConnected) ? 'Connected' : 'Not connected';
  next['jira'] = connLabel(jira);
  next['slack'] = connLabel(slack);
  next['zoom'] = connLabel(zoom);
  next['teams'] = connLabel(teams);
  next['meet'] = connLabel(meet);
  next['integrations'] = 'What syncs, and when to ask first';
  return next;
}

export function SettingsRootPage() {
  const { pop, push } = useNav();
  const [subs, setSubs] = useState<Record<string, string>>({});

  useEffect(() => {
    const a = api();
    Promise.allSettled([
      a.getConfig?.(),
      a.mcpStatus?.(),
      a.getVoicePrints?.(),
      fetchIntegrationStatuses(),
      a.getNotificationSettings?.(),
    ]).then(([cfg, mcp, prints, integrations, notifications]) => {
      const next: Record<string, string> = {};
      if (notifications.status === 'fulfilled' && notifications.value) next['notifications'] = notificationSummary(notifications.value);
      if (cfg.status === 'fulfilled' && cfg.value) {
        const c = cfg.value;
        next['ai'] = c.apiKey ? (c.apiProvider === 'openai' ? 'OpenAI · key added' : 'Anthropic · key added') : 'No API key yet';
        next['transcription'] = `Whisper ${c.whisperModel || 'small'}${c.calendarFreeRecording ? ' · auto-record on' : ''}`;
        next['voice'] = c.userName ? `Enrolled as ${c.userName}` : 'Not set up yet';
      }
      if (mcp.status === 'fulfilled' && mcp.value) {
        next['ai-connect'] = mcp.value.enabled ? `Local MCP on port ${mcp.value.port || ''}`.trim() : 'MCP server off';
      }
      if (prints.status === 'fulfilled' && Array.isArray(prints.value)) {
        const enrolled = prints.value.filter((p: any) => !String(p.name || '').startsWith('Unidentified')).length;
        if (enrolled > 0) next['voice'] = `${next['voice'] || 'Enrolled'} · ${enrolled} voice${enrolled === 1 ? '' : 's'}`;
      }
      next['data'] = 'Local only · export or clear';
      if (integrations.status === 'fulfilled') {
        const connected = ['calendar', 'jira', 'slack', 'zoom', 'teams', 'meet'].filter(k => {
          const value = integrations.value[k] || '';
          return value === 'Connected' || /^\d+ calendars? connected$/.test(value);
        }).length;
        next['integrations-hub'] = `${connected} of 6 connected`;
      }
      setSubs(next);
    });
  }, []);

  return (
    <>
      <div className="pp-drillhead">
        <button className="pp-back" aria-label="Back" onClick={pop}>←</button>
        <div className="pp-drilltitle">Settings</div>
        <span />
      </div>
      <div className="pp-body" style={{ paddingTop: 4 }}>
        <div className="pp-listcard">
          {SECTIONS.map(s => (
            <button
              key={s.key}
              className="pp-setrow"
              onClick={() => s.key === 'integrations-hub'
                ? push({ kind: 'settings-integrations' })
                : push({ kind: 'settings-section', section: s.key as SettingsSectionKey, title: s.label })}
            >
              <span className="pp-seticon">{s.icon}</span>
              <div className="pp-grow">
                <div className="pp-rowlabel">{s.label}</div>
                {subs[s.key] && <div className="pp-rowsub">{subs[s.key]}</div>}
              </div>
              <span className="pp-chevron">›</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

export function IntegrationsHubPage() {
  const { pop, push } = useNav();
  const [subs, setSubs] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchIntegrationStatuses().then(setSubs);
  }, []);

  return (
    <>
      <div className="pp-drillhead">
        <button className="pp-back" aria-label="Back" onClick={pop}>←</button>
        <div className="pp-drilltitle">Integrations</div>
        <span />
      </div>
      <div className="pp-body" style={{ paddingTop: 4 }}>
        <div className="pp-listcard">
          {INTEGRATION_ROWS.map(s => (
            <button
              key={s.key}
              className="pp-setrow"
              onClick={() => push({ kind: 'settings-section', section: s.key, title: s.label })}
            >
              <span className="pp-seticon">{s.icon}</span>
              <div className="pp-grow">
                <div className="pp-rowlabel">{s.label}</div>
                {subs[s.key] && <div className="pp-rowsub">{subs[s.key]}</div>}
              </div>
              <span className="pp-chevron">›</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

// ── Notifications (docs/OLLIE_MOMENTS.md, "Settings · Notifications") ──────

type Choice<T> = { label: string; value: T };
const MODE3: Array<Choice<'notify' | 'tray' | 'off'>> = [
  { label: 'Notify', value: 'notify' }, { label: 'Tray only', value: 'tray' }, { label: 'Off', value: 'off' },
];
const MORNING: Array<Choice<NotificationSettings['morning']>> = [
  { label: 'Window', value: 'window' }, { label: 'Tray only', value: 'tray' }, { label: 'Off', value: 'off' },
];
type PrepChoice = '5' | '10' | '15' | 'tray' | 'off';
const PREP: Array<Choice<PrepChoice>> = [
  { label: '5 min', value: '5' }, { label: '10 min', value: '10' }, { label: '15 min', value: '15' },
  { label: 'Tray only', value: 'tray' }, { label: 'Off', value: 'off' },
];

function notificationSummary(n: NotificationSettings): string {
  const prep = n.prep.mode === 'notify' ? `${n.prep.leadMinutes} min before meetings` : n.prep.mode === 'tray' ? 'Prep in tray only' : 'Prep off';
  const morning = n.morning === 'window' ? 'Morning plan window' : n.morning === 'tray' ? 'Morning plan in tray' : 'Morning plan off';
  return `${morning} · ${prep}`;
}

function Segmented<T extends string>({ label, sub, choices, value, onChange, disabled }: {
  label: string;
  sub?: string;
  choices: Array<Choice<T>>;
  value: T;
  onChange?: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="ol-setting">
      <div>
        <div className="pp-title-sm">{label}</div>
        {sub && <div className="pp-meta" style={{ marginTop: 2 }}>{sub}</div>}
      </div>
      <div className="pp-seg" role="radiogroup" aria-label={label}>
        {choices.map(c => (
          <button
            key={c.value}
            role="radio"
            aria-checked={value === c.value}
            className={value === c.value ? 'pp-on' : ''}
            disabled={disabled}
            onClick={() => onChange?.(c.value)}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function NotificationsSettings() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api().getNotificationSettings?.().then((s: NotificationSettings) => setSettings(s || null)).catch(() => setError("Couldn't load notification settings."));
  }, []);

  const save = async (patch: Record<string, unknown>) => {
    setError('');
    try {
      const next = await api().setNotificationSettings?.(patch);
      if (next) setSettings(next);
    } catch {
      setError("Couldn't save that change.");
    }
  };

  if (!settings) return error ? <div className="pp-meta">{error}</div> : null;
  const prepValue: PrepChoice = settings.prep.mode === 'notify' ? (String(settings.prep.leadMinutes) as PrepChoice) : settings.prep.mode;

  return (
    <div>
      <Segmented label="Morning plan" sub="Window opens the daily plan when your day starts." choices={MORNING} value={settings.morning} onChange={v => save({ morning: v })} />
      <Segmented
        label="Before a meeting"
        sub="Prep card with what's owed and waiting on your OK."
        choices={PREP}
        value={prepValue}
        onChange={v => save({ prep: v === 'tray' || v === 'off' ? { mode: v } : { mode: 'notify', leadMinutes: Number(v) } })}
      />
      <Segmented label="After a meeting" sub="When a transcript finishes processing." choices={MODE3} value={settings.processed} onChange={v => save({ processed: v })} />
      <Segmented label="End of day" sub="Wrap-up and what tomorrow needs." choices={MODE3} value={settings.wrapUp} onChange={v => save({ wrapUp: v })} />
      <Segmented label="Recording problems" sub="Mic lost, missing speaker audio, conflicts. Always notifies." choices={[{ label: 'Always on', value: 'on' }]} value="on" disabled />
      {error && <div className="pp-meta" style={{ color: 'var(--red)', marginTop: 8 }}>{error}</div>}
    </div>
  );
}

// ── Zoom OAuth header (PKCE): connect → waiting with pulse → connected ──────

type ZoomFlow = 'idle' | 'waiting' | 'connected' | 'failed';

function ZoomConnectHeader() {
  const [flow, setFlow] = useState<ZoomFlow>('idle');
  const [account, setAccount] = useState<string>('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const readStatus = async () => {
    try {
      const s = await api().zoomStatus?.();
      const connected = !!(s?.connected || s?.isConnected);
      if (connected) {
        setAccount(s?.email || s?.account || '');
        setFlow('connected');
        stopPolling();
      }
      return connected;
    } catch {
      return false;
    }
  };

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  };

  useEffect(() => {
    readStatus();
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async () => {
    setFlow('waiting');
    api().zoomConnect?.().then(() => readStatus()).catch(() => {});
    pollRef.current = setInterval(readStatus, 2000);
    timeoutRef.current = setTimeout(() => {
      stopPolling();
      setFlow(f => (f === 'waiting' ? 'failed' : f));
    }, 120_000);
  };

  const cancel = () => {
    stopPolling();
    setFlow('idle');
  };

  if (flow === 'connected') {
    return (
      <div className="pp-listcard" style={{ marginBottom: 10 }}>
        <div className="pp-setrow" style={{ cursor: 'default' }}>
          <span className="pp-seticon" style={{ borderRadius: '50%' }}>✓</span>
          <div className="pp-grow">
            <div className="pp-rowlabel">Zoom connected</div>
            {account && <div className="pp-rowsub">{account}</div>}
          </div>
          <span className="pp-chip pp-teal">Connected</span>
        </div>
      </div>
    );
  }

  if (flow === 'waiting') {
    return (
      <div className="pp-card" style={{ marginBottom: 10, padding: '16px 14px' }}>
        <div className="pp-row">
          <span className="pp-pulse" />
          <div className="pp-grow">
            <div className="pp-title-sm" style={{ fontSize: 13 }}>Waiting for Zoom…</div>
            <div className="pp-meta" style={{ marginTop: 3, lineHeight: 1.5 }}>
              Finish signing in in your browser. This window stays open.
            </div>
          </div>
        </div>
        <div className="pp-row" style={{ gap: 16, marginTop: 12, paddingLeft: 19 }}>
          <button className="pp-link" onClick={connect}>Reopen browser</button>
          <button className="pp-quiet-action" onClick={cancel}>Cancel</button>
        </div>
      </div>
    );
  }

  if (flow === 'failed') {
    return (
      <div className="pp-card" style={{ marginBottom: 10, padding: '14px' }}>
        <div className="pp-title-sm" style={{ fontSize: 13 }}>That didn't finish</div>
        <div className="pp-meta" style={{ marginTop: 3, lineHeight: 1.5 }}>
          The sign-in timed out — if you closed the browser tab, that's why.
        </div>
        <div className="pp-row" style={{ marginTop: 10 }}>
          <button className="pp-btn pp-solid" style={{ padding: '6px 14px' }} onClick={connect}>Try again</button>
        </div>
      </div>
    );
  }

  return (
    <div className="pp-card" style={{ marginBottom: 10 }}>
      <div className="pp-row">
        <div className="pp-grow">
          <div className="pp-title-sm">Connect Zoom</div>
          <div className="pp-meta" style={{ marginTop: 2 }}>Sign in happens in your browser — nothing to paste.</div>
        </div>
        <button className="pp-btn pp-solid" style={{ padding: '6px 14px' }} onClick={connect}>Connect</button>
      </div>
    </div>
  );
}

// ── Section page ─────────────────────────────────────────────────────────────

const AUTH_SECTIONS: SettingsSectionKey[] = ['zoom', 'teams', 'meet', 'calendar', 'jira', 'slack'];

export function SettingsSectionPage({ section, title }: { section: SettingsSectionKey; title: string }) {
  const { pop } = useNav();

  // Pin the popup open while a section that can launch a browser OAuth flow is
  // on screen — otherwise the popup hides the instant the browser takes focus.
  useEffect(() => {
    if (!AUTH_SECTIONS.includes(section)) return;
    api().pinPopup?.(true);
    return () => { api().pinPopup?.(false); };
  }, [section]);

  return (
    <>
      <div className="pp-drillhead">
        <button className="pp-back" aria-label="Back" onClick={pop}>←</button>
        <div className="pp-drilltitle">{title}</div>
        <span />
      </div>
      <div className="pp-body" style={{ paddingTop: 4 }}>
        {section === 'zoom' && <ZoomConnectHeader />}
        {section === 'notifications' ? <NotificationsSettings /> : <Settings only={section} />}
      </div>
    </>
  );
}
