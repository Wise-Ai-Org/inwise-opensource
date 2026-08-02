import React, { useEffect, useRef, useState } from 'react';
import { api, useNav, SettingsSectionKey } from './nav';
import Settings from '../Settings';

const SECTIONS: Array<{ key: SettingsSectionKey | 'integrations-hub'; icon: string; label: string }> = [
  { key: 'ai', icon: '✦', label: 'AI provider' },
  { key: 'startup', icon: '▸', label: 'Startup & daily plan' },
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
    ]).then(([cfg, mcp, prints, integrations]) => {
      const next: Record<string, string> = {};
      if (cfg.status === 'fulfilled' && cfg.value) {
        const c = cfg.value;
        next['ai'] = c.apiKey ? (c.apiProvider === 'openai' ? 'OpenAI · key added' : 'Anthropic · key added') : 'No API key yet';
        next['transcription'] = `Whisper ${c.whisperModel || 'base'}${c.calendarFreeRecording ? ' · auto-record on' : ''}`;
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
            <div className="pp-title-sm" style={{ fontSize: 14 }}>Waiting for Zoom…</div>
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
        <div className="pp-title-sm" style={{ fontSize: 14 }}>That didn't finish</div>
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
        <Settings only={section} />
      </div>
    </>
  );
}
