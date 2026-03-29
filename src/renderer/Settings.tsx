import React, { useState, useEffect } from 'react';

interface Config {
  apiProvider: 'anthropic' | 'openai';
  apiKey: string;
  whisperModel: 'tiny' | 'base' | 'small' | 'medium';
  googleIcsUrl: string;
  outlookIcsUrl: string;
}

type TestStatus = 'idle' | 'testing' | 'ok' | 'error';

function IcsField({
  label,
  value,
  onChange,
  placeholder,
  steps,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  steps: string[];
}) {
  const [status, setStatus] = useState<TestStatus>('idle');
  const [statusMsg, setStatusMsg] = useState('');

  const test = async () => {
    if (!value.trim()) return;
    setStatus('testing');
    setStatusMsg('');
    const result = await (window as any).inwiseAPI.testCalendarUrl(value.trim());
    if (result.ok) {
      setStatus('ok');
      setStatusMsg(`Connected — ${result.eventCount} upcoming event${result.eventCount !== 1 ? 's' : ''} found`);
    } else {
      setStatus('error');
      setStatusMsg(result.error || 'Could not read calendar. Double-check the URL.');
    }
  };

  const statusColor = status === 'ok' ? 'var(--teal)' : status === 'error' ? 'var(--red)' : 'var(--slate-500)';

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--navy)', marginBottom: 10 }}>{label}</div>

      <ol style={{ paddingLeft: 18, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {steps.map((step, i) => (
          <li key={i} style={{ fontSize: 13, color: 'var(--slate-700)', lineHeight: 1.5 }}
            dangerouslySetInnerHTML={{ __html: step }} />
        ))}
      </ol>

      <div style={{ display: 'flex', gap: 8 }}>
        <input
          className="form-input"
          style={{ flex: 1 }}
          value={value}
          onChange={e => { onChange(e.target.value); setStatus('idle'); }}
          placeholder={placeholder}
        />
        <button
          className="btn btn-secondary btn-sm"
          onClick={test}
          disabled={!value.trim() || status === 'testing'}
          style={{ flexShrink: 0 }}
        >
          {status === 'testing' ? 'Testing…' : 'Test'}
        </button>
      </div>

      {status !== 'idle' && (
        <div style={{ fontSize: 12, color: statusColor, marginTop: 6 }}>
          {status === 'ok' && '✓ '}{status === 'error' && '✕ '}{statusMsg}
        </div>
      )}
    </div>
  );
}

export default function Settings() {
  const [config, setConfig] = useState<Config | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (window as any).inwiseAPI.getConfig().then(setConfig);
  }, []);

  if (!config) return null;

  const update = (key: keyof Config, value: string) => {
    setConfig(c => c ? { ...c, [key]: value } : c);
    setSaved(false);
  };

  const save = async () => {
    await (window as any).inwiseAPI.setConfig(config);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <>
      <div className="page-header">
        <div className="page-title">Settings</div>
        <div className="page-subtitle">Configure your AI provider, transcription model, and calendar</div>
      </div>
      <div className="page-body">
        <div className="settings-sections">

          {/* AI Provider */}
          <div className="settings-section">
            <div className="settings-section-title">AI Provider</div>

            <div className="form-group">
              <label className="form-label">Provider</label>
              <select
                className="form-select"
                value={config.apiProvider}
                onChange={e => update('apiProvider', e.target.value)}
              >
                <option value="anthropic">Anthropic (Claude Haiku)</option>
                <option value="openai">OpenAI (GPT-4o mini)</option>
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">
                {config.apiProvider === 'anthropic' ? 'Anthropic API Key' : 'OpenAI API Key'}
              </label>
              <input
                type="password"
                className="form-input"
                value={config.apiKey}
                onChange={e => update('apiKey', e.target.value)}
                placeholder={config.apiProvider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
              />
            </div>
          </div>

          {/* Transcription */}
          <div className="settings-section">
            <div className="settings-section-title">Transcription</div>
            <div className="form-group">
              <label className="form-label">Whisper Model</label>
              <select
                className="form-select"
                value={config.whisperModel}
                onChange={e => update('whisperModel', e.target.value)}
              >
                <option value="tiny">Tiny (~75 MB) — fastest</option>
                <option value="base">Base (~148 MB) — recommended</option>
                <option value="small">Small (~488 MB) — better accuracy</option>
                <option value="medium">Medium (~1.5 GB) — best accuracy</option>
              </select>
              <span style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 4 }}>
                Downloaded automatically on first use. Runs 100% locally — no audio ever leaves your device.
              </span>
            </div>
          </div>

          {/* Calendar */}
          <div className="settings-section">
            <div className="settings-section-title">Calendar</div>
            <p style={{ fontSize: 13, color: 'var(--slate-500)', marginBottom: 20, lineHeight: 1.6 }}>
              inWise uses your calendar's private ICS link to detect upcoming meetings.
              No login or app registration required — just a URL you copy in about 30 seconds.
              The link is only used locally on your machine.
            </p>

            <IcsField
              label="Google Calendar"
              value={config.googleIcsUrl}
              onChange={v => update('googleIcsUrl', v)}
              placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
              steps={[
                'Open <strong>Google Calendar</strong> in your browser',
                'Click the <strong>⚙ Settings</strong> gear (top right) → <strong>Settings</strong>',
                'In the left panel, click your calendar name under <em>Settings for my calendars</em>',
                'Scroll down to <strong>"Secret address in iCal format"</strong>',
                'Click <strong>copy</strong> and paste the URL below',
              ]}
            />

            <IcsField
              label="Outlook / Microsoft 365"
              value={config.outlookIcsUrl}
              onChange={v => update('outlookIcsUrl', v)}
              placeholder="https://outlook.live.com/owa/calendar/…/calendar.ics"
              steps={[
                'Open <strong>Outlook</strong> (web or desktop)',
                'Go to <strong>Calendar</strong> → right-click your calendar → <strong>Share</strong>',
                'Choose <strong>"Publish this calendar"</strong> → set permissions to <em>Can view all details</em>',
                'Copy the <strong>ICS link</strong> and paste it below',
              ]}
            />
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="btn btn-primary" onClick={save}>Save Settings</button>
            {saved && <span style={{ fontSize: 13, color: 'var(--teal)' }}>✓ Saved</span>}
          </div>

        </div>
      </div>
    </>
  );
}
