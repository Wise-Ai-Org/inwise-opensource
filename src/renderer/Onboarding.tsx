import React, { useState, useEffect, useRef } from 'react';
// @ts-ignore
import inwiseLogo from '../../assets/inwise_logo.png';

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

  // Setup step state
  const [setupStatus, setSetupStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [setupMessage, setSetupMessage] = useState('');
  const [setupPct, setSetupPct] = useState(0);

  // Voice enrollment state
  const [userName, setUserName] = useState('');
  const [voiceStatus, setVoiceStatus] = useState<'idle' | 'recording' | 'saving' | 'done' | 'error'>('idle');
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [voiceCountdown, setVoiceCountdown] = useState(10);
  const [voiceError, setVoiceError] = useState('');
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceRafRef = useRef<number>(0);

  const steps = ['Welcome', 'AI Provider', 'Transcription', 'Setup', 'Your Voice', 'Integrations', 'Getting Ready'];

  // Integrations step state
  const [jiraClientId, setJiraClientId] = useState('');
  const [jiraClientSecret, setJiraClientSecret] = useState('');
  const [jiraConnecting, setJiraConnecting] = useState(false);
  const [jiraConnected, setJiraConnected] = useState(false);
  const [jiraError, setJiraError] = useState('');
  const [googleIcsUrl, setGoogleIcsUrl] = useState('');
  const [outlookIcsUrl, setOutlookIcsUrl] = useState('');
  const [calendarTesting, setCalendarTesting] = useState(false);
  const [calendarStatus, setCalendarStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [calendarMsg, setCalendarMsg] = useState('');

  // Demo seed state
  const [seedStatus, setSeedStatus] = useState<'idle' | 'seeding' | 'done' | 'error'>('idle');
  const [seedMessage, setSeedMessage] = useState('');

  // Listen for progress events from main process
  useEffect(() => {
    const handler = ({ message, pct }: { message: string; pct: number }) => {
      setSetupMessage(message);
      setSetupPct(pct);
    };
    (window as any).inwiseAPI.on('whisper:progress', handler);
    return () => (window as any).inwiseAPI.off('whisper:progress', handler);
  }, []);

  const next = () => {
    setError('');
    if (step === 1 && !apiKey.trim()) {
      setError('Please enter your API key.');
      return;
    }
    if (step < steps.length - 1) {
      setStep(step + 1);
    }
  };

  // Auto-start setup when step 3 is reached
  useEffect(() => {
    if (step === 3 && setupStatus === 'idle') {
      runSetup();
    }
  }, [step]);

  const runSetup = async () => {
    setSetupStatus('running');
    setSetupMessage('Starting setup…');
    setSetupPct(0);
    // Save config first so whisper model choice is available
    await (window as any).inwiseAPI.setConfig({
      apiProvider,
      apiKey: apiKey.trim(),
      whisperModel,
    });
    const result = await (window as any).inwiseAPI.setupWhisper(whisperModel);
    if (result.ok) {
      setSetupStatus('done');
      setSetupMessage('Ready to go!');
      setSetupPct(100);
    } else {
      setSetupStatus('error');
      setSetupMessage(result.error || 'Setup failed');
    }
  };

  const recordVoice = async () => {
    if (!userName.trim()) { setError('Please enter your name first.'); return; }
    setVoiceStatus('recording');
    setVoiceLevel(0);
    setVoiceCountdown(10);
    setVoiceError('');
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceStreamRef.current = stream;

      // Level meter
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setVoiceLevel(Math.min(100, (avg / 128) * 100));
        voiceRafRef.current = requestAnimationFrame(tick);
      };
      tick();

      // Countdown
      let remaining = 10;
      const countdownId = setInterval(() => {
        remaining--;
        setVoiceCountdown(remaining);
      }, 1000);

      // Record
      const chunks: Blob[] = [];
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      mr.start(250);

      setTimeout(async () => {
        clearInterval(countdownId);
        cancelAnimationFrame(voiceRafRef.current);
        mr.stop();
        stream.getTracks().forEach(t => t.stop());
        voiceStreamRef.current = null;
        setVoiceLevel(0);
        setVoiceStatus('saving');

        await new Promise<void>(resolve => { mr.onstop = () => resolve(); });

        // Convert to WAV
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const arrayBuffer = await blob.arrayBuffer();
        const audioCtx = new AudioContext({ sampleRate: 16000 });
        const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
        audioCtx.close();
        ctx.close();

        const pcm = decoded.getChannelData(0);
        const samples = new Int16Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) {
          samples[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
        }
        const dataLength = samples.length * 2;
        const wav = new ArrayBuffer(44 + dataLength);
        const view = new DataView(wav);
        const w = (off: number, str: string) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
        w(0, 'RIFF'); view.setUint32(4, 36 + dataLength, true);
        w(8, 'WAVE'); w(12, 'fmt '); view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
        view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        w(36, 'data'); view.setUint32(40, dataLength, true);
        new Int16Array(wav, 44).set(samples);

        try {
          const result = await (window as any).inwiseAPI.saveVoicePrint({
            name: userName.trim(),
            audioClip: new Uint8Array(wav),
            isUser: true,
          });
          if (result.ok) {
            setVoiceStatus('done');
          } else {
            setVoiceError(result.error || 'Failed to save voice print');
            setVoiceStatus('error');
          }
        } catch (e: any) {
          setVoiceError(e.message || 'Failed to save');
          setVoiceStatus('error');
        }
      }, 10000);
    } catch (e: any) {
      setVoiceError(e.message || 'Could not access microphone');
      setVoiceStatus('error');
    }
  };

  // Cleanup voice recording on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(voiceRafRef.current);
      voiceStreamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  const runSeedAndFinish = async () => {
    setSeedStatus('seeding');
    setSeedMessage('Setting up your workspace...');
    try {
      const updates: Record<string, any> = { onboardingComplete: true };
      if (userName.trim()) updates.userName = userName.trim();
      if (googleIcsUrl.trim()) updates.googleIcsUrl = googleIcsUrl.trim();
      if (outlookIcsUrl.trim()) updates.outlookIcsUrl = outlookIcsUrl.trim();
      await (window as any).inwiseAPI.setConfig(updates);

      setSeedMessage('Creating sample meetings and tasks...');
      const result = await (window as any).inwiseAPI.seedDemoData();

      if (result?.seeded) {
        setSeedMessage(`Ready! Loaded ${result.meetings} meetings, ${result.tasks} tasks, and ${result.people} people.`);
      } else {
        setSeedMessage('Workspace ready!');
      }
      setSeedStatus('done');

      // Auto-proceed after a short pause so user can read the message
      setTimeout(() => onComplete(), 1500);
    } catch (e: any) {
      setSeedStatus('error');
      setSeedMessage(e.message || 'Something went wrong, but you can still use the app.');
    }
  };

  const handleJiraConnect = async () => {
    if (!jiraClientId.trim() || !jiraClientSecret.trim()) {
      setJiraError('Please enter both Client ID and Client Secret.');
      return;
    }
    setJiraConnecting(true);
    setJiraError('');
    try {
      await (window as any).inwiseAPI.setConfig({ jiraClientId: jiraClientId.trim(), jiraClientSecret: jiraClientSecret.trim() });
      const result = await (window as any).inwiseAPI.jiraConnect();
      if (result.ok) {
        setJiraConnected(true);
        await (window as any).inwiseAPI.setConfig({ jiraAutoPush: true });
      } else {
        setJiraError(result.error || 'Connection failed. Check your credentials.');
      }
    } catch (e: any) {
      setJiraError(e.message || 'Connection failed.');
    } finally {
      setJiraConnecting(false);
    }
  };

  const handleCalendarTest = async () => {
    const url = (googleIcsUrl.trim() || outlookIcsUrl.trim());
    if (!url) return;
    setCalendarTesting(true);
    setCalendarStatus('idle');
    try {
      await (window as any).inwiseAPI.setConfig({
        googleIcsUrl: googleIcsUrl.trim() || undefined,
        outlookIcsUrl: outlookIcsUrl.trim() || undefined,
      });
      const result = await (window as any).inwiseAPI.testCalendarUrl(url);
      if (result.ok) {
        setCalendarStatus('ok');
        setCalendarMsg(`Connected — ${result.eventCount} upcoming event${result.eventCount !== 1 ? 's' : ''} found`);
      } else {
        setCalendarStatus('error');
        setCalendarMsg(result.error || 'Could not fetch calendar feed.');
      }
    } catch (e: any) {
      setCalendarStatus('error');
      setCalendarMsg(e.message || 'Connection failed.');
    } finally {
      setCalendarTesting(false);
    }
  };

  // Auto-trigger seed when step 6 is reached
  useEffect(() => {
    if (step === 6 && seedStatus === 'idle') {
      runSeedAndFinish();
    }
  }, [step]);

  return (
    <div className="onboarding-wrap">
      <div className="onboarding-card">
        <img src={inwiseLogo} alt="Inwise" className="onboarding-logo" />

        <div className="onboarding-steps">
          {steps.map((_, i) => (
            <div key={i} className={`step-dot${i <= step ? ' active' : ''}`} />
          ))}
        </div>

        {step === 0 && (
          <>
            <div className="onboarding-title">Welcome to Inwise</div>
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
            <div className="onboarding-subtitle">
              Choose your Whisper model. We'll download it in the next step — runs offline forever after.
            </div>

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

        {step === 3 && (
          <>
            <div className="onboarding-title">Setting Up Transcription</div>
            <div className="onboarding-subtitle">
              Downloading the Whisper engine and your selected model. This only happens once.
            </div>

            <div style={{ margin: '24px 0' }}>
              {/* Progress bar */}
              <div style={{ height: 8, background: 'var(--slate-200)', borderRadius: 4, overflow: 'hidden', marginBottom: 10 }}>
                <div style={{
                  height: '100%',
                  width: `${setupPct}%`,
                  background: setupStatus === 'error' ? 'var(--red)' : 'var(--teal)',
                  borderRadius: 4,
                  transition: 'width 0.3s ease',
                }} />
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{
                  fontSize: 13,
                  color: setupStatus === 'error' ? 'var(--red)' : 'var(--slate-600)',
                }}>
                  {setupStatus === 'done' && '✓ '}
                  {setupMessage}
                </span>
                <span style={{ fontSize: 12, color: 'var(--slate-400)', fontVariantNumeric: 'tabular-nums' }}>
                  {setupPct}%
                </span>
              </div>

              {setupStatus === 'error' && (
                <button
                  className="btn btn-secondary btn-sm"
                  style={{ marginTop: 12 }}
                  onClick={() => { setSetupStatus('idle'); runSetup(); }}
                >
                  Retry
                </button>
              )}
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <div className="onboarding-title">Your Voice</div>
            <div className="onboarding-subtitle">
              Record a short clip so Inwise can identify you in meetings.
              Other participants' voices are learned automatically from your 1:1 recordings.
            </div>

            <div className="form-group" style={{ marginBottom: 16 }}>
              <label className="form-label">Your Name</label>
              <input
                type="text"
                className="form-input"
                value={userName}
                onChange={e => setUserName(e.target.value)}
                placeholder="e.g. Shravya"
                autoFocus
                disabled={voiceStatus === 'recording' || voiceStatus === 'saving'}
              />
            </div>

            {voiceStatus === 'idle' && (
              <button className="btn btn-secondary" onClick={recordVoice} disabled={!userName.trim()}>
                Record 10 seconds
              </button>
            )}

            {voiceStatus === 'recording' && (
              <div>
                <div style={{ fontSize: 12, color: 'var(--slate-500)', marginBottom: 6 }}>
                  Speak naturally for {voiceCountdown}s — describe your day, read something aloud, anything works.
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ flex: 1, height: 8, background: 'var(--slate-200)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ width: `${voiceLevel}%`, height: '100%', background: 'var(--teal)', borderRadius: 4, transition: 'width 0.05s' }} />
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--slate-500)', minWidth: 32, fontVariantNumeric: 'tabular-nums' }}>{voiceCountdown}s</span>
                </div>
              </div>
            )}

            {voiceStatus === 'saving' && (
              <div style={{ fontSize: 12, color: 'var(--slate-500)' }}>Saving voice print…</div>
            )}

            {voiceStatus === 'done' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 13, color: 'var(--teal)' }}>✓ Voice enrolled as "{userName.trim()}"</div>
                <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setVoiceStatus('idle')}>
                  Re-record
                </button>
              </div>
            )}

            {voiceStatus === 'error' && (
              <div>
                <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>✕ {voiceError}</div>
                <button className="btn btn-secondary btn-sm" onClick={() => setVoiceStatus('idle')}>Try Again</button>
              </div>
            )}
          </>
        )}

        {step === 5 && (
          <>
            <div className="onboarding-title">Integrations</div>
            <div className="onboarding-subtitle">
              Connect your tools to get the most out of Inwise. Both are optional — you can set these up later in Settings.
            </div>

            {/* Jira */}
            <div style={{ margin: '20px 0', padding: '16px', background: 'var(--slate-50)', borderRadius: 8, border: '1px solid var(--slate-200)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <span style={{ fontSize: 16 }}>🔗</span>
                <span style={{ fontSize: 14, fontWeight: 700 }}>Jira</span>
                {jiraConnected && <span style={{ fontSize: 11, color: 'var(--teal)', fontWeight: 700, background: 'rgba(13,148,136,0.1)', borderRadius: 4, padding: '2px 8px' }}>Connected</span>}
              </div>
              {jiraConnected ? (
                <div style={{ fontSize: 13, color: 'var(--teal)' }}>✓ Jira connected with auto-sync enabled. Tasks from meetings will be pushed automatically.</div>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <input className="form-input" placeholder="Jira Client ID" value={jiraClientId} onChange={e => setJiraClientId(e.target.value)} style={{ flex: 1, fontSize: 13 }} />
                    <input className="form-input" placeholder="Client Secret" type="password" value={jiraClientSecret} onChange={e => setJiraClientSecret(e.target.value)} style={{ flex: 1, fontSize: 13 }} />
                  </div>
                  <button className="btn btn-secondary btn-sm" onClick={handleJiraConnect} disabled={jiraConnecting}>
                    {jiraConnecting ? 'Connecting…' : 'Connect to Jira'}
                  </button>
                  {jiraError && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>{jiraError}</div>}
                </>
              )}
            </div>

            {/* Calendar */}
            <div style={{ padding: '16px', background: 'var(--slate-50)', borderRadius: 8, border: '1px solid var(--slate-200)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <span style={{ fontSize: 16 }}>📅</span>
                <span style={{ fontSize: 14, fontWeight: 700 }}>Calendar</span>
                {calendarStatus === 'ok' && <span style={{ fontSize: 11, color: 'var(--teal)', fontWeight: 700, background: 'rgba(13,148,136,0.1)', borderRadius: 4, padding: '2px 8px' }}>Connected</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--slate-500)', marginBottom: 8 }}>
                Paste your ICS feed URL to auto-detect upcoming meetings. Find it in Google Calendar or Outlook settings.
              </div>
              <input className="form-input" placeholder="Google Calendar ICS URL" value={googleIcsUrl} onChange={e => setGoogleIcsUrl(e.target.value)} style={{ fontSize: 13, marginBottom: 6, width: '100%' }} />
              <input className="form-input" placeholder="Outlook Calendar ICS URL (optional)" value={outlookIcsUrl} onChange={e => setOutlookIcsUrl(e.target.value)} style={{ fontSize: 13, marginBottom: 8, width: '100%' }} />
              <button className="btn btn-secondary btn-sm" onClick={handleCalendarTest} disabled={calendarTesting || (!googleIcsUrl.trim() && !outlookIcsUrl.trim())}>
                {calendarTesting ? 'Testing…' : 'Test Connection'}
              </button>
              {calendarStatus === 'ok' && <div style={{ fontSize: 12, color: 'var(--teal)', marginTop: 6 }}>✓ {calendarMsg}</div>}
              {calendarStatus === 'error' && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>{calendarMsg}</div>}
            </div>
          </>
        )}

        {step === 6 && (
          <>
            <div className="onboarding-title">
              {seedStatus === 'done' ? 'You\'re All Set!' : 'Getting Ready'}
            </div>
            <div className="onboarding-subtitle">
              {seedStatus === 'seeding' && 'We\'re loading sample data so you can explore Inwise right away — real meetings, tasks, and people to interact with.'}
              {seedStatus === 'done' && 'Your workspace is ready with sample meetings, action items, and people. Explore everything — it\'s all interactive.'}
              {seedStatus === 'error' && 'Something went wrong loading sample data, but your workspace is ready to use.'}
            </div>

            <div style={{ margin: '24px 0', textAlign: 'center' }}>
              {seedStatus === 'seeding' && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
                  <div style={{
                    width: 48, height: 48, border: '3px solid var(--slate-200)', borderTopColor: 'var(--teal)',
                    borderRadius: '50%', animation: 'spin 1s linear infinite',
                  }} />
                  <span style={{ fontSize: 13, color: 'var(--slate-600)' }}>{seedMessage}</span>
                </div>
              )}
              {seedStatus === 'done' && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                  <div style={{ fontSize: 40 }}>&#10003;</div>
                  <span style={{ fontSize: 14, color: 'var(--teal)', fontWeight: 600 }}>{seedMessage}</span>
                </div>
              )}
              {seedStatus === 'error' && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 13, color: 'var(--red)' }}>{seedMessage}</span>
                  <button className="btn btn-primary" onClick={onComplete}>Continue Anyway</button>
                </div>
              )}
            </div>

            <div style={{
              padding: '12px 16px', background: 'var(--slate-50)', borderRadius: 8,
              border: '1px solid var(--slate-200)', fontSize: 12, color: 'var(--slate-500)',
            }}>
              <strong>Tip:</strong> You can remove the sample data anytime from Settings → Data Management.
            </div>
          </>
        )}

        {error && (
          <div style={{ fontSize: 13, color: 'var(--red)', marginBottom: 16 }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          {step > 0 && step < 3 && (
            <button className="btn btn-secondary" onClick={() => setStep(step - 1)}>Back</button>
          )}
          {step < 3 && (
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={next}>
              Continue
            </button>
          )}
          {step === 3 && setupStatus === 'done' && (
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => setStep(4)}>
              Continue
            </button>
          )}
          {step === 3 && setupStatus === 'running' && (
            <button className="btn btn-primary" style={{ flex: 1 }} disabled>
              Downloading…
            </button>
          )}
          {step === 4 && (
            <button
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={() => setStep(5)}
              disabled={!userName.trim() || voiceStatus === 'recording' || voiceStatus === 'saving'}
            >
              {voiceStatus === 'done' ? 'Continue' : 'Skip & Continue'}
            </button>
          )}
          {step === 5 && (
            <button
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={() => setStep(6)}
              disabled={jiraConnecting || calendarTesting}
            >
              {(jiraConnected || calendarStatus === 'ok') ? 'Continue' : 'Skip for Now'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
