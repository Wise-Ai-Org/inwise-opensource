import React, { useState, useEffect } from 'react';
// @ts-ignore — webpack asset/resource import
import inwiseLogo from '../../assets/inwise_logo.png';

type View = 'communications' | 'tasks' | 'people' | 'settings';

interface Props {
  activeView: View;
  onNavigate: (v: View) => void;
}

const NAV_TOP: { id: View; label: string; icon: React.ReactNode }[] = [
  {
    id: 'communications',
    label: 'Communications',
    icon: (
      <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    id: 'tasks',
    label: 'My Tasks',
    icon: (
      <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    ),
  },
  {
    id: 'people',
    label: 'People',
    icon: (
      <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  },
];

function openEnterprise() {
  (window as any).inwiseAPI?.openExternal('https://inwise.ai/enterprise');
}

type AudioHealth = { micOk: boolean; systemAudioOk: boolean; message?: string };

export default function Sidebar({ activeView, onNavigate }: Props) {
  const [recording, setRecording] = useState(false);
  const [received, setReceived] = useState(false);
  const [showTitleInput, setShowTitleInput] = useState(false);
  const [title, setTitle] = useState('');
  const [audioHealth, setAudioHealth] = useState<AudioHealth | null>(null);

  const [showSearchInput, setShowSearchInput] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResult, setSearchResult] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleSearch = async () => {
    const q = searchQuery.trim();
    if (!q) return;
    setSearchLoading(true);
    setSearchError(null);
    try {
      const res = await (window as any).inwiseAPI?.searchMeetings(q);
      if (res?.ok) {
        setSearchResult(res.answer);
        setShowSearchInput(false);
        setSearchQuery('');
      } else {
        setSearchError(res?.error || 'Something went wrong');
      }
    } catch (e: any) {
      setSearchError(e.message || 'Something went wrong');
    } finally {
      setSearchLoading(false);
    }
  };

  const handleCopy = () => {
    if (searchResult) {
      navigator.clipboard.writeText(searchResult);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  useEffect(() => {
    const handler = ({ status }: { status: string }) => {
      if (status === 'done' || status === 'error') {
        setRecording(false);
        setReceived(true);
        setTimeout(() => setReceived(false), 4000);
      }
    };
    (window as any).inwiseAPI?.on('recording:status', handler);
    return () => (window as any).inwiseAPI?.off('recording:status', handler);
  }, []);

  useEffect(() => {
    (window as any).inwiseAPI?.getAudioHealth?.().then((h: AudioHealth | null) => {
      if (h) setAudioHealth(h);
    }).catch(() => {});
    const healthHandler = (h: AudioHealth) => setAudioHealth(h);
    (window as any).inwiseAPI?.on('audio:health', healthHandler);
    return () => (window as any).inwiseAPI?.off('audio:health', healthHandler);
  }, []);

  const startRecording = async () => {
    let activeEvent: { id: string; title: string } | null = null;
    try {
      activeEvent = await (window as any).inwiseAPI?.getActiveCalendarEvent();
    } catch {
      activeEvent = null;
    }
    const typed = title.trim();
    const t = typed || activeEvent?.title || 'Meeting';
    setShowTitleInput(false);
    setTitle('');
    setReceived(false);
    setRecording(true);
    await (window as any).inwiseAPI?.startRecording(t, activeEvent?.id);
  };

  const stopRecording = async () => {
    setRecording(false);
    setReceived(true);
    await (window as any).inwiseAPI?.stopRecording();
    setTimeout(() => setReceived(false), 4000);
  };

  return (
    <aside className="sidebar">
      {searchResult && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)' }}
          onClick={() => setSearchResult(null)}
        >
          <div
            style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 540, width: 'calc(100% - 48px)', maxHeight: '70vh', display: 'flex', flexDirection: 'column', gap: 16, boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>Meeting search</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={handleCopy}
                  style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#f8fafc', cursor: 'pointer', color: copied ? '#16a34a' : '#334155' }}
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
                <button
                  onClick={() => setSearchResult(null)}
                  style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#f8fafc', cursor: 'pointer', color: '#334155' }}
                >
                  Close
                </button>
              </div>
            </div>
            <div style={{ overflowY: 'auto', fontSize: 13, lineHeight: 1.65, color: '#334155', whiteSpace: 'pre-wrap' }}>
              {searchResult}
            </div>
          </div>
        </div>
      )}

      <div className="sidebar-logo">
        <img src={inwiseLogo} alt="Inwise" />
      </div>

      <nav className="sidebar-nav">
        {NAV_TOP.map((item) => (
          <button
            key={item.id}
            data-nav={item.id}
            className={`nav-item${activeView === item.id ? ' active' : ''}`}
            onClick={() => onNavigate(item.id)}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </nav>

      <div className="sidebar-record">
        {showSearchInput ? (
          <div className="record-title-input">
            <input
              autoFocus
              className="form-input"
              placeholder="Ask about your meetings…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSearch();
                if (e.key === 'Escape') { setShowSearchInput(false); setSearchQuery(''); setSearchError(null); }
              }}
              disabled={searchLoading}
            />
            <button className="btn btn-primary btn-sm" onClick={handleSearch} disabled={searchLoading || !searchQuery.trim()}>
              {searchLoading ? '…' : 'Ask'}
            </button>
          </div>
        ) : (
          <button className="record-btn" style={{ background: 'transparent', opacity: 0.7 }} onClick={() => { setShowSearchInput(true); setSearchError(null); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            Search meetings
          </button>
        )}
        {searchError && (
          <div style={{ fontSize: 11, color: '#ef4444', padding: '4px 8px' }}>{searchError}</div>
        )}
      </div>

      <div className="sidebar-record">
        {showTitleInput && !recording && (
          <div className="record-title-input">
            <input
              autoFocus
              className="form-input"
              placeholder="Meeting title…"
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') startRecording(); if (e.key === 'Escape') setShowTitleInput(false); }}
            />
            <button className="btn btn-primary btn-sm" onClick={startRecording}>Start</button>
          </div>
        )}
        {received ? (
          <div className="record-received">
            ✓ Recording received — check Inwise for insights
          </div>
        ) : recording ? (
          <button className="record-btn recording" onClick={stopRecording}>
            <span className="record-dot" />
            Stop Recording
            {audioHealth && (!audioHealth.micOk || !audioHealth.systemAudioOk) && (
              <span
                className="audio-health-dot"
                title={audioHealth.message || (!audioHealth.micOk ? 'Microphone unavailable' : 'System audio unavailable')}
                aria-label="Audio capture issue"
              />
            )}
          </button>
        ) : (
          <button className="record-btn" onClick={() => setShowTitleInput(v => !v)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="12" r="8" />
            </svg>
            Record Meeting
            {audioHealth && (!audioHealth.micOk || !audioHealth.systemAudioOk) && (
              <span
                className="audio-health-dot"
                title={audioHealth.message || (!audioHealth.micOk ? 'Microphone unavailable' : 'System audio unavailable')}
                aria-label="Audio capture issue"
              />
            )}
          </button>
        )}
      </div>

      <div className="sidebar-bottom">
        <button className="enterprise-cta" onClick={openEnterprise}>
          <span className="enterprise-cta-emoji">✨</span>
          <div className="enterprise-cta-text">
            <span className="enterprise-cta-title">Going big?</span>
            <span className="enterprise-cta-sub">Get the team on board</span>
          </div>
          <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" style={{ flexShrink: 0, opacity: 0.5 }}>
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" />
          </svg>
        </button>

        <button
          data-nav="settings"
          className={`nav-item${activeView === 'settings' ? ' active' : ''}`}
          onClick={() => onNavigate('settings')}
        >
          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          Settings
        </button>
      </div>
    </aside>
  );
}
