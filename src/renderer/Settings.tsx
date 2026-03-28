import React, { useState, useEffect } from 'react';

interface Config {
  apiProvider: 'anthropic' | 'openai';
  apiKey: string;
  whisperModel: 'tiny' | 'base' | 'small' | 'medium';
  googleClientId: string;
  googleClientSecret: string;
  microsoftClientId: string;
}

export default function Settings() {
  const [config, setConfig] = useState<Config | null>(null);
  const [saved, setSaved] = useState(false);
  const [calStatus, setCalStatus] = useState<string>('');

  useEffect(() => {
    (window as any).inwiseAPI.getConfig().then(setConfig);
  }, []);

  if (!config) return null;

  const update = (key: keyof Config, value: string) => {
    setConfig((c) => c ? { ...c, [key]: value } : c);
    setSaved(false);
  };

  const save = async () => {
    await (window as any).inwiseAPI.setConfig(config);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const connectCalendar = async (provider: 'google' | 'microsoft') => {
    setCalStatus(`Connecting to ${provider}…`);
    try {
      const fn = provider === 'google'
        ? (window as any).inwiseAPI.loginGoogle
        : (window as any).inwiseAPI.loginMicrosoft;
      const result = await fn();
      setCalStatus(`✓ Connected as ${result.email}`);
    } catch (e: any) {
      setCalStatus(`Error: ${e.message}`);
    }
  };

  return (
    <>
      <div className="page-header">
        <div className="page-title">Settings</div>
        <div className="page-subtitle">Configure your API keys, model, and calendar</div>
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
                onChange={(e) => update('apiProvider', e.target.value)}
              >
                <option value="anthropic">Anthropic (Claude)</option>
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
                onChange={(e) => update('apiKey', e.target.value)}
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
                onChange={(e) => update('whisperModel', e.target.value)}
              >
                <option value="tiny">Tiny (~75 MB) — fastest</option>
                <option value="base">Base (~148 MB) — recommended</option>
                <option value="small">Small (~488 MB) — better accuracy</option>
                <option value="medium">Medium (~1.5 GB) — best accuracy</option>
              </select>
              <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>
                Model is downloaded automatically on first use. All transcription runs locally — no audio leaves your device.
              </span>
            </div>
          </div>

          {/* Calendar */}
          <div className="settings-section">
            <div className="settings-section-title">Calendar Integration</div>
            <p style={{ fontSize: 13, color: 'var(--slate-500)', marginBottom: 16 }}>
              Register your own OAuth app (free, ~5 min). See the README for setup instructions.
              Add <code>http://localhost:3579</code> as the redirect URI.
            </p>

            <div className="form-group">
              <label className="form-label">Google Client ID</label>
              <input
                className="form-input"
                value={config.googleClientId}
                onChange={(e) => update('googleClientId', e.target.value)}
                placeholder="xxxxx.apps.googleusercontent.com"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Google Client Secret</label>
              <input
                type="password"
                className="form-input"
                value={config.googleClientSecret}
                onChange={(e) => update('googleClientSecret', e.target.value)}
                placeholder="GOCSPX-…"
              />
            </div>

            <button className="oauth-btn" onClick={() => connectCalendar('google')}>
              <svg width="18" height="18" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Connect Google Calendar
            </button>

            <div className="form-group" style={{ marginTop: 12 }}>
              <label className="form-label">Microsoft Client ID</label>
              <input
                className="form-input"
                value={config.microsoftClientId}
                onChange={(e) => update('microsoftClientId', e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              />
            </div>

            <button className="oauth-btn" onClick={() => connectCalendar('microsoft')}>
              <svg width="18" height="18" viewBox="0 0 24 24">
                <rect x="1" y="1" width="10" height="10" fill="#F25022"/>
                <rect x="13" y="1" width="10" height="10" fill="#7FBA00"/>
                <rect x="1" y="13" width="10" height="10" fill="#00A4EF"/>
                <rect x="13" y="13" width="10" height="10" fill="#FFB900"/>
              </svg>
              Connect Microsoft Calendar
            </button>

            {calStatus && (
              <div style={{ fontSize: 13, color: calStatus.startsWith('✓') ? 'var(--teal)' : calStatus.startsWith('Error') ? 'var(--red)' : 'var(--slate-500)', marginTop: 8 }}>
                {calStatus}
              </div>
            )}
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
