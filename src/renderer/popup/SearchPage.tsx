import React, { useState } from 'react';
import { api, useNav } from './nav';

export default function SearchPage() {
  const { pop } = useNav();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = async () => {
    const q = query.trim();
    if (!q || loading) return;
    setLoading(true);
    setError(null);
    setAnswer(null);
    try {
      const res = await api().searchMeetings?.(q);
      if (res?.success !== false) {
        setAnswer(typeof res === 'string' ? res : res?.answer || '');
      } else {
        setError(res?.error || 'Something went wrong');
      }
    } catch (e: any) {
      setError(e?.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  const copy = () => {
    if (!answer) return;
    navigator.clipboard.writeText(answer);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <div className="pp-drillhead">
        <button className="pp-back" aria-label="Back" onClick={pop}>←</button>
        <div className="pp-drilltitle">Search meetings</div>
        <span />
      </div>
      <div className="pp-body" style={{ paddingTop: 4 }}>
        <div className="pp-search">
          <span style={{ color: 'var(--slate-300)' }}>⌕</span>
          <input
            autoFocus
            placeholder="Ask about your meetings…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') run(); }}
            disabled={loading}
          />
          <button className="pp-link" onClick={run} disabled={loading || !query.trim()}>
            {loading ? '…' : 'Ask'}
          </button>
        </div>

        {loading && (
          <div className="pp-row" style={{ justifyContent: 'center', gap: 8, padding: '20px 0' }}>
            <span className="pp-pulse" />
            <span className="pp-meta">Reading your meetings…</span>
          </div>
        )}

        {error && (
          <div className="pp-card" style={{ borderColor: '#fecaca' }}>
            <div style={{ fontSize: 12.5, color: 'var(--red)', lineHeight: 1.5 }}>{error}</div>
          </div>
        )}

        {answer && (
          <div className="pp-card">
            <div className="pp-row" style={{ marginBottom: 8 }}>
              <div className="pp-grow" style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--pp-teal-deep)' }}>
                Answer
              </div>
              <button className="pp-quiet-action" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--slate-700)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{answer}</div>
          </div>
        )}

        {!answer && !loading && !error && (
          <div className="pp-meta" style={{ padding: '4px 4px', lineHeight: 1.6 }}>
            Try: "What did we decide about pricing?" · "What does Priya owe me?" · "Summarize this week's standups"
          </div>
        )}
      </div>
    </>
  );
}
