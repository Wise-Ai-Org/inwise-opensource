import React, { useState } from 'react';

interface Props {
  onComplete: () => void;
}

export default function Onboarding({ onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [apiProvider, setApiProvider] = useState<'anthropic' | 'openai'>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [whisperModel, setWhisperModel] = useState<'tiny' | 'base' | 'small' | 'medium'>('base');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const steps = ['Welcome', 'AI Provider', 'Transcription'];

  const next = () => {
    setError('');
    if (step === 1 && !apiKey.trim()) {
      setError('Please enter your API key.');
      return;
    }
    if (step < steps.length - 1) {
      setStep(step + 1);
    } else {
      finish();
    }
  };

  const finish = async () => {
    setSaving(true);
    try {
      await (window as any).inwiseAPI.setConfig({
        apiProvider,
        apiKey: apiKey.trim(),
        whisperModel,
        onboardingComplete: true,
      });
      onComplete();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="onboarding-wrap">
      <div className="onboarding-card">
        <img src="../../assets/inwise_logo.png" alt="inWise" className="onboarding-logo" />

        <div className="onboarding-steps">
          {steps.map((_, i) => (
            <div key={i} className={`step-dot${i <= step ? ' active' : ''}`} />
          ))}
        </div>

        {step === 0 && (
          <>
            <div className="onboarding-title">Welcome to inWise</div>
            <div className="onboarding-subtitle">
              AI-powered meeting recorder that runs entirely on your machine.
              No audio ever leaves your device.
            </div>
            <ul style={{ listStyle: 'none', marginBottom: 28 }}>
              {[
                '🎙️ Local transcription via Whisper',
                '🤖 AI insights via Claude or GPT-4',
                '📅 Auto-detects calendar meetings',
                '🔒 Everything stays on your machine',
              ].map((item) => (
                <li key={item} style={{ padding: '6px 0', fontSize: 14, color: 'var(--slate-700)' }}>
                  {item}
                </li>
              ))}
            </ul>
          </>
        )}

        {step === 1 && (
          <>
            <div className="onboarding-title">AI Provider</div>
            <div className="onboarding-subtitle">Used to extract action items and insights from transcripts.</div>

            <div className="form-group">
              <label className="form-label">Provider</label>
              <select
                className="form-select"
                value={apiProvider}
                onChange={(e) => setApiProvider(e.target.value as any)}
              >
                <option value="anthropic">Anthropic (Claude Haiku)</option>
                <option value="openai">OpenAI (GPT-4o mini)</option>
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">
                {apiProvider === 'anthropic' ? 'Anthropic API Key' : 'OpenAI API Key'}
              </label>
              <input
                type="password"
                className="form-input"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={apiProvider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
                autoFocus
              />
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="onboarding-title">Transcription Model</div>
            <div className="onboarding-subtitle">Choose your Whisper model. Downloaded on first use, runs offline forever after.</div>

            <div className="form-group">
              <label className="form-label">Whisper Model</label>
              <select
                className="form-select"
                value={whisperModel}
                onChange={(e) => setWhisperModel(e.target.value as any)}
              >
                <option value="tiny">Tiny (~75 MB) — fastest, lower accuracy</option>
                <option value="base">Base (~148 MB) — recommended</option>
                <option value="small">Small (~488 MB) — better accuracy</option>
                <option value="medium">Medium (~1.5 GB) — best accuracy, slowest</option>
              </select>
              <span style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 4 }}>
                You can change this later in Settings.
              </span>
            </div>
          </>
        )}

        {error && (
          <div style={{ fontSize: 13, color: 'var(--red)', marginBottom: 16 }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          {step > 0 && (
            <button className="btn btn-secondary" onClick={() => setStep(step - 1)}>Back</button>
          )}
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={next} disabled={saving}>
            {step === steps.length - 1 ? (saving ? 'Setting up…' : 'Get Started') : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
