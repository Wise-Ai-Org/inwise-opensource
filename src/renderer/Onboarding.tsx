import React, { useEffect, useRef, useState } from 'react';
// @ts-ignore - webpack asset/resource import
import inwiseLogo from '../../assets/inwise_logo.png';

interface Props {
  onComplete: () => void;
}

interface SlackChannel {
  id: string;
  name: string;
}

type SetupStatus = 'idle' | 'running' | 'done' | 'error';
type VoiceStatus = 'idle' | 'recording' | 'saving' | 'done' | 'error';
type FinishStatus = 'idle' | 'saving' | 'done' | 'error';

const api = () => (window as any).inwiseAPI;
const steps = ['Set up', 'Connect', 'Ready'] as const;

export default function Onboarding({ onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [apiProvider, setApiProvider] = useState<'anthropic' | 'openai'>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [whisperModel, setWhisperModel] = useState<'tiny' | 'base' | 'small' | 'medium'>('base');
  const [userName, setUserName] = useState('');
  const [error, setError] = useState('');

  const [setupStatus, setSetupStatus] = useState<SetupStatus>('idle');
  const [setupMessage, setSetupMessage] = useState('');
  const [setupPct, setSetupPct] = useState(0);

  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('idle');
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [voiceCountdown, setVoiceCountdown] = useState(10);
  const [voiceError, setVoiceError] = useState('');
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceRafRef = useRef<number>(0);

  const [zoomConnected, setZoomConnected] = useState(false);
  const [zoomConnecting, setZoomConnecting] = useState(false);
  const [zoomError, setZoomError] = useState('');

  const [slackConnected, setSlackConnected] = useState(false);
  const [slackConnecting, setSlackConnecting] = useState(false);
  const [slackTeamName, setSlackTeamName] = useState('');
  const [slackError, setSlackError] = useState('');
  const [slackChannels, setSlackChannels] = useState<SlackChannel[]>([]);
  const [slackChannelsLoading, setSlackChannelsLoading] = useState(false);
  const [slackReadChannels, setSlackReadChannels] = useState<string[]>([]);
  const [slackWriteChannels, setSlackWriteChannels] = useState<string[]>([]);
  const [slackInactivityWindowMin, setSlackInactivityWindowMin] = useState(60);

  const [moreIntegrationsOpen, setMoreIntegrationsOpen] = useState(false);
  const [jiraClientId, setJiraClientId] = useState('');
  const [jiraClientSecret, setJiraClientSecret] = useState('');
  const [jiraConnecting, setJiraConnecting] = useState(false);
  const [jiraConnected, setJiraConnected] = useState(false);
  const [jiraError, setJiraError] = useState('');
  const [googleIcsUrl, setGoogleIcsUrl] = useState('');
  const [outlookIcsUrl, setOutlookIcsUrl] = useState('');
  const [calendarTesting, setCalendarTesting] = useState(false);
  const [calendarStatus, setCalendarStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [calendarMessage, setCalendarMessage] = useState('');

  const [addSampleData, setAddSampleData] = useState(true);
  const [finishStatus, setFinishStatus] = useState<FinishStatus>('idle');
  const [finishMessage, setFinishMessage] = useState('');

  const loadSlackChannels = async () => {
    setSlackChannelsLoading(true);
    try {
      const result = await api().slackListChannels?.();
      if (result?.ok) {
        setSlackChannels(result.channels ?? []);
        setSlackError('');
      } else {
        setSlackError(result?.error || 'Could not load Slack channels.');
      }
    } catch (e: any) {
      setSlackError(e.message || 'Could not load Slack channels.');
    } finally {
      setSlackChannelsLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      api().getConfig?.(),
      api().zoomStatus?.(),
      api().slackStatus?.(),
      api().jiraStatus?.(),
    ]).then(([configResult, zoomResult, slackResult, jiraResult]) => {
      if (cancelled) return;
      if (configResult.status === 'fulfilled' && configResult.value) {
        const config = configResult.value;
        setApiProvider(config.apiProvider || 'anthropic');
        setApiKey(config.apiKey || '');
        setWhisperModel(config.whisperModel || 'base');
        setUserName(config.userName || '');
        setGoogleIcsUrl(config.googleIcsUrl || '');
        setOutlookIcsUrl(config.outlookIcsUrl || '');
        setJiraClientId(config.jiraClientId || '');
        setJiraClientSecret(config.jiraClientSecret || '');
        setSlackReadChannels(config.slackReadChannels || []);
        setSlackWriteChannels(config.slackWriteChannels || []);
        setSlackInactivityWindowMin(config.slackInactivityWindowMin || 60);
      }
      if (zoomResult.status === 'fulfilled') setZoomConnected(!!zoomResult.value?.connected);
      if (slackResult.status === 'fulfilled') {
        const connected = !!slackResult.value?.connected;
        setSlackConnected(connected);
        if (connected) void loadSlackChannels();
      }
      if (jiraResult.status === 'fulfilled') setJiraConnected(!!jiraResult.value?.connected);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const handler = ({ message, pct }: { message: string; pct: number }) => {
      setSetupMessage(message);
      setSetupPct(pct);
    };
    api().on?.('whisper:progress', handler);
    return () => api().off?.('whisper:progress', handler);
  }, []);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(voiceRafRef.current);
      voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const runSetup = async () => {
    setError('');
    if (!userName.trim()) {
      setError('Enter your name to continue.');
      return;
    }
    if (!apiKey.trim()) {
      setError('Enter your AI provider API key to continue.');
      return;
    }
    if (voiceStatus === 'recording' || voiceStatus === 'saving') return;
    if (setupStatus === 'done') {
      setStep(1);
      return;
    }

    setSetupStatus('running');
    setSetupMessage('Preparing local transcription...');
    setSetupPct(0);
    try {
      await api().setConfig({
        apiProvider,
        apiKey: apiKey.trim(),
        whisperModel,
        userName: userName.trim(),
      });
      const result = await api().setupWhisper(whisperModel);
      if (!result?.ok) throw new Error(result?.error || 'Transcription setup failed.');
      setSetupStatus('done');
      setSetupMessage('Local transcription is ready.');
      setSetupPct(100);
      setStep(1);
    } catch (e: any) {
      setSetupStatus('error');
      setSetupMessage(e.message || 'Transcription setup failed.');
    }
  };

  const recordVoice = async () => {
    if (!userName.trim()) {
      setError('Enter your name before recording a voice sample.');
      return;
    }
    setVoiceStatus('recording');
    setVoiceLevel(0);
    setVoiceCountdown(10);
    setVoiceError('');
    setError('');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceStreamRef.current = stream;
      const meterContext = new AudioContext();
      const source = meterContext.createMediaStreamSource(stream);
      const analyser = meterContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const meterData = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(meterData);
        const average = meterData.reduce((sum, value) => sum + value, 0) / meterData.length;
        setVoiceLevel(Math.min(100, (average / 128) * 100));
        voiceRafRef.current = requestAnimationFrame(tick);
      };
      tick();

      let remaining = 10;
      const countdownId = setInterval(() => {
        remaining -= 1;
        setVoiceCountdown(remaining);
      }, 1000);

      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.start(250);

      setTimeout(async () => {
        clearInterval(countdownId);
        cancelAnimationFrame(voiceRafRef.current);
        const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
        recorder.stop();
        stream.getTracks().forEach((track) => track.stop());
        voiceStreamRef.current = null;
        setVoiceLevel(0);
        setVoiceStatus('saving');
        await stopped;

        try {
          const blob = new Blob(chunks, { type: 'audio/webm' });
          const encodedAudio = await blob.arrayBuffer();
          const audioContext = new AudioContext({ sampleRate: 16000 });
          const decoded = await audioContext.decodeAudioData(encodedAudio.slice(0));
          await audioContext.close();
          await meterContext.close();

          const pcm = decoded.getChannelData(0);
          const samples = new Int16Array(pcm.length);
          for (let i = 0; i < pcm.length; i += 1) {
            samples[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
          }
          const dataLength = samples.length * 2;
          const wav = new ArrayBuffer(44 + dataLength);
          const view = new DataView(wav);
          const write = (offset: number, value: string) => {
            for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
          };
          write(0, 'RIFF'); view.setUint32(4, 36 + dataLength, true);
          write(8, 'WAVE'); write(12, 'fmt '); view.setUint32(16, 16, true);
          view.setUint16(20, 1, true); view.setUint16(22, 1, true);
          view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
          view.setUint16(32, 2, true); view.setUint16(34, 16, true);
          write(36, 'data'); view.setUint32(40, dataLength, true);
          new Int16Array(wav, 44).set(samples);

          const result = await api().saveVoicePrint({
            name: userName.trim(),
            audioClip: new Uint8Array(wav),
            isUser: true,
          });
          if (!result?.ok) throw new Error(result?.error || 'Could not save your voice sample.');
          setVoiceStatus('done');
        } catch (e: any) {
          setVoiceError(e.message || 'Could not save your voice sample.');
          setVoiceStatus('error');
        }
      }, 10000);
    } catch (e: any) {
      setVoiceError(e.message || 'Could not access the microphone.');
      setVoiceStatus('error');
    }
  };

  const connectZoom = async () => {
    setZoomConnecting(true);
    setZoomError('');
    try {
      const result = await api().zoomConnect?.();
      if (!result?.ok) throw new Error(result?.error || 'Zoom connection failed.');
      setZoomConnected(true);
    } catch (e: any) {
      setZoomError(e.message || 'Zoom connection failed.');
    } finally {
      setZoomConnecting(false);
    }
  };

  const connectSlack = async () => {
    setSlackConnecting(true);
    setSlackError('');
    try {
      const result = await api().slackConnectOAuth?.();
      if (!result?.ok) throw new Error(result?.error || 'Slack connection failed.');
      setSlackConnected(true);
      setSlackTeamName(result.teamName || '');
      await loadSlackChannels();
    } catch (e: any) {
      setSlackError(e.message || 'Slack connection failed.');
    } finally {
      setSlackConnecting(false);
    }
  };

  const toggleSlackChannel = (
    channelId: string,
    selected: string[],
    setSelected: React.Dispatch<React.SetStateAction<string[]>>,
  ) => {
    setSelected(selected.includes(channelId)
      ? selected.filter((id) => id !== channelId)
      : [...selected, channelId]);
  };

  const connectJira = async () => {
    if (!jiraClientId.trim() || !jiraClientSecret.trim()) {
      setJiraError('Enter both the Jira client ID and client secret.');
      return;
    }
    setJiraConnecting(true);
    setJiraError('');
    try {
      await api().setConfig({
        jiraClientId: jiraClientId.trim(),
        jiraClientSecret: jiraClientSecret.trim(),
      });
      const result = await api().jiraConnect?.();
      if (!result?.ok) throw new Error(result?.error || 'Jira connection failed.');
      setJiraConnected(true);
      await api().setConfig({ jiraAutoPush: true });
    } catch (e: any) {
      setJiraError(e.message || 'Jira connection failed.');
    } finally {
      setJiraConnecting(false);
    }
  };

  const testCalendar = async () => {
    const url = googleIcsUrl.trim() || outlookIcsUrl.trim();
    if (!url) return;
    setCalendarTesting(true);
    setCalendarStatus('idle');
    try {
      await api().setConfig({
        googleIcsUrl: googleIcsUrl.trim(),
        outlookIcsUrl: outlookIcsUrl.trim(),
      });
      const result = await api().testCalendarUrl?.(url);
      if (!result?.ok) throw new Error(result?.error || 'Calendar connection failed.');
      setCalendarStatus('ok');
      setCalendarMessage(`${result.eventCount || 0} upcoming event${result.eventCount === 1 ? '' : 's'} found.`);
    } catch (e: any) {
      setCalendarStatus('error');
      setCalendarMessage(e.message || 'Calendar connection failed.');
    } finally {
      setCalendarTesting(false);
    }
  };

  const continueFromConnections = async () => {
    setError('');
    try {
      await api().setConfig({
        googleIcsUrl: googleIcsUrl.trim(),
        outlookIcsUrl: outlookIcsUrl.trim(),
        slackReadChannels,
        slackWriteChannels,
        slackInactivityWindowMin,
      });
      setStep(2);
    } catch (e: any) {
      setError(e.message || 'Could not save integration settings.');
    }
  };

  const finish = async () => {
    setFinishStatus('saving');
    setFinishMessage(addSampleData ? 'Adding example meetings and tasks...' : 'Saving your workspace...');
    setError('');
    try {
      await api().setConfig({
        onboardingComplete: true,
        userName: userName.trim(),
        googleIcsUrl: googleIcsUrl.trim(),
        outlookIcsUrl: outlookIcsUrl.trim(),
        slackReadChannels,
        slackWriteChannels,
        slackInactivityWindowMin,
      });

      if (addSampleData) {
        const result = await api().seedDemoData?.();
        if (result?.seeded) {
          setFinishMessage(`Added ${result.meetings} meetings, ${result.tasks} tasks, and ${result.people} people.`);
        } else {
          setFinishMessage('Your workspace is ready.');
        }
      } else {
        setFinishMessage('Your workspace is ready.');
      }
      setFinishStatus('done');
      setTimeout(onComplete, 700);
    } catch (e: any) {
      setFinishStatus('error');
      setFinishMessage(e.message || 'Could not finish setup.');
    }
  };

  const providerLabel = apiProvider === 'anthropic' ? 'Anthropic' : 'OpenAI';
  const connectionCount = [zoomConnected, slackConnected, jiraConnected, calendarStatus === 'ok'].filter(Boolean).length;

  return (
    <div className="onboarding-wrap">
      <div className="onboarding-card onboarding-card-three-step">
        <div className="onboarding-header">
          <img src={inwiseLogo} alt="Inwise" className="onboarding-logo" />
          <span className="onboarding-step-count">Step {step + 1} of 3</span>
        </div>

        <div className="onboarding-steps onboarding-steps-labeled" aria-label="Onboarding progress">
          {steps.map((label, index) => (
            <div key={label} className={`onboarding-step${index <= step ? ' active' : ''}${index === step ? ' current' : ''}`}>
              <span className="step-dot" />
              <span>{label}</span>
            </div>
          ))}
        </div>

        {step === 0 && (
          <>
            <div className="onboarding-title">Make Inwise yours</div>
            <div className="onboarding-subtitle">Transcribe meetings locally and turn them into useful notes.</div>

            <div className="onboarding-form-grid">
              <div className="form-group">
                <label className="form-label" htmlFor="onboarding-name">Your name</label>
                <input
                  id="onboarding-name"
                  className="form-input"
                  value={userName}
                  onChange={(event) => setUserName(event.target.value)}
                  placeholder="e.g. Shravani"
                  disabled={voiceStatus === 'recording' || voiceStatus === 'saving'}
                  autoFocus
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="onboarding-whisper">Transcription quality</label>
                <select
                  id="onboarding-whisper"
                  className="form-select"
                  value={whisperModel}
                  onChange={(event) => {
                    setWhisperModel(event.target.value as typeof whisperModel);
                    setSetupStatus('idle');
                  }}
                >
                  <option value="tiny">Tiny - fastest</option>
                  <option value="base">Base - recommended</option>
                  <option value="small">Small - more accurate</option>
                  <option value="medium">Medium - most accurate</option>
                </select>
              </div>
            </div>

            <div className="onboarding-panel">
              <div className="onboarding-panel-title">AI for meeting insights</div>
              <div className="onboarding-inline-fields">
                <select
                  className="form-select"
                  aria-label="AI provider"
                  value={apiProvider}
                  onChange={(event) => setApiProvider(event.target.value as typeof apiProvider)}
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                </select>
                <input
                  type="password"
                  className="form-input"
                  aria-label={`${providerLabel} API key`}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={apiProvider === 'anthropic' ? 'Anthropic API key' : 'OpenAI API key'}
                />
              </div>
            </div>

            <div className="onboarding-panel onboarding-voice-panel">
              <div>
                <div className="onboarding-panel-title">Teach Inwise your voice</div>
                <div className="onboarding-panel-copy">Optional 10-second sample for better speaker labels.</div>
              </div>
              {voiceStatus === 'idle' && (
                <button className="btn btn-secondary btn-sm" onClick={recordVoice}>Record sample</button>
              )}
              {voiceStatus === 'recording' && (
                <div className="onboarding-voice-progress" aria-label={`${voiceCountdown} seconds remaining`}>
                  <div className="onboarding-level"><span style={{ width: `${voiceLevel}%` }} /></div>
                  <span>{voiceCountdown}s</span>
                </div>
              )}
              {voiceStatus === 'saving' && <span className="onboarding-muted">Saving...</span>}
              {voiceStatus === 'done' && (
                <button className="btn btn-secondary btn-sm" onClick={() => setVoiceStatus('idle')}>Recorded - redo</button>
              )}
              {voiceStatus === 'error' && (
                <button className="btn btn-secondary btn-sm" onClick={() => setVoiceStatus('idle')}>Try again</button>
              )}
            </div>
            {voiceError && <div className="onboarding-error">{voiceError}</div>}

            <div className="onboarding-privacy-line">LLM processes transcripts; recordings remain private.</div>

            {setupStatus !== 'idle' && (
              <div className="onboarding-setup-progress">
                <div className="onboarding-progress-track">
                  <span className={setupStatus === 'error' ? 'error' : ''} style={{ width: `${setupPct}%` }} />
                </div>
                <div className={setupStatus === 'error' ? 'onboarding-error' : 'onboarding-muted'}>{setupMessage}</div>
              </div>
            )}
          </>
        )}

        {step === 1 && (
          <>
            <div className="onboarding-title">Connect your work</div>
            <div className="onboarding-subtitle">Bring in the conversations you choose. Everything here is optional.</div>

            <div className="onboarding-integration-list">
              <div className="onboarding-integration-card">
                <div className="onboarding-integration-icon">Z</div>
                <div className="onboarding-integration-copy">
                  <div className="onboarding-panel-title">Zoom</div>
                  <div className="onboarding-panel-copy">Import only completed transcripts you choose. Audio and video stay in Zoom.</div>
                  {zoomError && <div className="onboarding-error">{zoomError}</div>}
                </div>
                <button className="btn btn-secondary btn-sm" onClick={connectZoom} disabled={zoomConnecting || zoomConnected}>
                  {zoomConnected ? 'Connected' : zoomConnecting ? 'Waiting...' : 'Connect Zoom'}
                </button>
              </div>

              <div className="onboarding-integration-card onboarding-integration-card-slack">
                <div className="onboarding-integration-icon">S</div>
                <div className="onboarding-integration-copy">
                  <div className="onboarding-panel-title">Slack</div>
                  <div className="onboarding-panel-copy">Read selected channels and post only to channels you approve.</div>
                  {slackTeamName && <div className="onboarding-connected-copy">Connected to {slackTeamName}</div>}
                  {slackError && <div className="onboarding-error">{slackError}</div>}
                </div>
                <button className="btn btn-secondary btn-sm" onClick={connectSlack} disabled={slackConnecting || slackConnected}>
                  {slackConnected ? 'Connected' : slackConnecting ? 'Waiting...' : 'Connect Slack'}
                </button>

                {slackConnected && (
                  <div className="onboarding-integration-options">
                    <div className="onboarding-options-header">
                      <span>Choose Slack access</span>
                      {slackChannels.length === 0 && (
                        <button className="onboarding-text-button" onClick={loadSlackChannels} disabled={slackChannelsLoading}>
                          {slackChannelsLoading ? 'Loading...' : 'Load channels'}
                        </button>
                      )}
                    </div>
                    {slackChannels.length > 0 && (
                      <div className="onboarding-channel-columns">
                        <fieldset>
                          <legend>Read channels</legend>
                          <div className="onboarding-channel-list">
                            {slackChannels.map((channel) => (
                              <label key={`read-${channel.id}`}>
                                <input
                                  type="checkbox"
                                  checked={slackReadChannels.includes(channel.id)}
                                  onChange={() => toggleSlackChannel(channel.id, slackReadChannels, setSlackReadChannels)}
                                />
                                #{channel.name}
                              </label>
                            ))}
                          </div>
                        </fieldset>
                        <fieldset>
                          <legend>Write channels</legend>
                          <div className="onboarding-channel-list">
                            {slackChannels.map((channel) => (
                              <label key={`write-${channel.id}`}>
                                <input
                                  type="checkbox"
                                  checked={slackWriteChannels.includes(channel.id)}
                                  onChange={() => toggleSlackChannel(channel.id, slackWriteChannels, setSlackWriteChannels)}
                                />
                                #{channel.name}
                              </label>
                            ))}
                          </div>
                        </fieldset>
                      </div>
                    )}
                    <label className="onboarding-inactivity-field">
                      Thread inactivity
                      <select
                        className="form-select"
                        value={slackInactivityWindowMin}
                        onChange={(event) => setSlackInactivityWindowMin(Number(event.target.value))}
                      >
                        <option value={30}>30 minutes</option>
                        <option value={60}>60 minutes</option>
                        <option value={120}>2 hours</option>
                      </select>
                    </label>
                  </div>
                )}
              </div>
            </div>

            <button
              className="onboarding-more-toggle"
              onClick={() => setMoreIntegrationsOpen((open) => !open)}
              aria-expanded={moreIntegrationsOpen}
            >
              <span>Calendar and Jira</span>
              <span>{moreIntegrationsOpen ? '-' : '+'}</span>
            </button>

            {moreIntegrationsOpen && (
              <div className="onboarding-more-integrations">
                <div className="onboarding-panel">
                  <div className="onboarding-panel-title">Calendar</div>
                  <div className="onboarding-panel-copy">Add Google or Outlook ICS feeds for meeting reminders.</div>
                  <input className="form-input" value={googleIcsUrl} onChange={(event) => setGoogleIcsUrl(event.target.value)} placeholder="Google Calendar ICS URL" />
                  <input className="form-input" value={outlookIcsUrl} onChange={(event) => setOutlookIcsUrl(event.target.value)} placeholder="Outlook Calendar ICS URL" />
                  <button className="btn btn-secondary btn-sm" onClick={testCalendar} disabled={calendarTesting || (!googleIcsUrl.trim() && !outlookIcsUrl.trim())}>
                    {calendarTesting ? 'Testing...' : calendarStatus === 'ok' ? 'Connected' : 'Test connection'}
                  </button>
                  {calendarMessage && <div className={calendarStatus === 'error' ? 'onboarding-error' : 'onboarding-connected-copy'}>{calendarMessage}</div>}
                </div>

                <div className="onboarding-panel">
                  <div className="onboarding-panel-title">Jira</div>
                  <div className="onboarding-panel-copy">Turn approved meeting actions into Jira work.</div>
                  {!jiraConnected && (
                    <>
                      <input className="form-input" value={jiraClientId} onChange={(event) => setJiraClientId(event.target.value)} placeholder="Jira client ID" />
                      <input type="password" className="form-input" value={jiraClientSecret} onChange={(event) => setJiraClientSecret(event.target.value)} placeholder="Jira client secret" />
                    </>
                  )}
                  <button className="btn btn-secondary btn-sm" onClick={connectJira} disabled={jiraConnecting || jiraConnected}>
                    {jiraConnected ? 'Connected' : jiraConnecting ? 'Waiting...' : 'Connect Jira'}
                  </button>
                  {jiraError && <div className="onboarding-error">{jiraError}</div>}
                </div>
              </div>
            )}

            <div className="onboarding-privacy-line">LLM processes transcripts; recordings remain private.</div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="onboarding-title">You're ready</div>
            <div className="onboarding-subtitle">Inwise can now capture context and help you follow through.</div>

            <div className="onboarding-summary-grid">
              <div className="onboarding-summary-item">
                <span>Transcription</span>
                <strong>{whisperModel.charAt(0).toUpperCase() + whisperModel.slice(1)} - local</strong>
              </div>
              <div className="onboarding-summary-item">
                <span>Meeting insights</span>
                <strong>{providerLabel}</strong>
              </div>
              <div className="onboarding-summary-item">
                <span>Connections</span>
                <strong>{connectionCount || 'Optional'}</strong>
              </div>
            </div>

            <label className="onboarding-sample-option">
              <input type="checkbox" checked={addSampleData} onChange={(event) => setAddSampleData(event.target.checked)} />
              <span>
                <strong>Start with sample data</strong>
                <small>Add example meetings, tasks, and people so you can explore immediately.</small>
              </span>
            </label>

            <div className="onboarding-privacy-line">Your settings and imported content stay on this computer.</div>

            {finishStatus !== 'idle' && (
              <div className={finishStatus === 'error' ? 'onboarding-error onboarding-finish-status' : 'onboarding-connected-copy onboarding-finish-status'}>
                {finishMessage}
              </div>
            )}
          </>
        )}

        {error && <div className="onboarding-error onboarding-global-error">{error}</div>}

        <div className="onboarding-actions">
          {step > 0 && finishStatus === 'idle' && (
            <button className="btn btn-secondary" onClick={() => { setError(''); setStep(step - 1); }}>Back</button>
          )}
          {step === 0 && (
            <button className="btn btn-primary" onClick={runSetup} disabled={setupStatus === 'running' || voiceStatus === 'recording' || voiceStatus === 'saving'}>
              {setupStatus === 'running' ? 'Preparing transcription...' : setupStatus === 'error' ? 'Retry setup' : 'Continue'}
            </button>
          )}
          {step === 1 && (
            <button className="btn btn-primary" onClick={continueFromConnections} disabled={zoomConnecting || slackConnecting || jiraConnecting || calendarTesting}>
              Continue - connections optional
            </button>
          )}
          {step === 2 && (
            <button className="btn btn-primary" onClick={finish} disabled={finishStatus === 'saving' || finishStatus === 'done'}>
              {finishStatus === 'saving' ? 'Finishing...' : finishStatus === 'done' ? 'Ready' : 'Finish setup'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
