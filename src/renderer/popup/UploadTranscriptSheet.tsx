import React, { useState } from 'react';

// Local YYYY-MM-DD for the date picker default (NOT toISOString, which uses UTC
// and can show tomorrow's date in the evening west of UTC).
const localDateString = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Anchor a YYYY-MM-DD picker value to local noon so the stored timestamp always
// lands on the chosen calendar day in the user's timezone. Parsing the date-only
// string directly (new Date('2026-05-31')) yields UTC midnight, which renders as
// the previous day west of UTC — the "uploaded today, shows yesterday" bug.
const localNoonISO = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0).toISOString();
};

interface Props {
  open: boolean;
  onClose: () => void;
  onUpload: (data: { title: string; content: string; date: string }) => Promise<void>;
  /** When set, the transcript attaches to this existing meeting — no title/date asked. */
  attachTo?: string;
}

export default function UploadTranscriptSheet({ open, onClose, onUpload, attachTo }: Props) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(localDateString(new Date()));
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  if (!open) return null;

  const canSubmit = content.trim().length > 0 && (!!attachTo || title.trim().length > 0);

  const submit = async () => {
    if (!canSubmit || saving) return;
    setSaving(true);
    setError('');
    try {
      await onUpload({
        title: attachTo ? attachTo : title.trim(),
        content: content.trim(),
        date: localNoonISO(date),
      });
      setTitle('');
      setContent('');
      setDate(localDateString(new Date()));
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Upload failed — try again.');
    } finally {
      setSaving(false);
    }
  };

  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 2px' };
  const controlStyle: React.CSSProperties = { border: 'none', outline: 'none', fontSize: 12.5, fontWeight: 600, color: 'var(--teal)', background: 'transparent', fontFamily: 'inherit', textAlign: 'right' };

  return (
    <>
      <div className="pp-sheet-backdrop" onClick={onClose} />
      <div className="pp-sheet" role="dialog" aria-label={attachTo ? 'Attach a transcript' : 'Upload a transcript'}>
        <div className="pp-sheet-handle" />
        <div className="pp-title-sm" style={{ fontSize: 15 }}>
          {attachTo ? 'Attach a transcript' : 'Upload a transcript'}
        </div>
        <div className="pp-meta" style={{ marginTop: -4 }}>
          {attachTo
            ? `It joins “${attachTo}” and Wiser pulls out the insights.`
            : 'Paste a transcript from anywhere — Wiser turns it into a meeting with insights.'}
        </div>
        {!attachTo && (
          <div className="pp-search">
            <input
              autoFocus
              placeholder="What was the meeting about?"
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
            />
          </div>
        )}
        {!attachTo && (
          <div className="pp-listcard">
            <div style={rowStyle}>
              <span style={{ fontSize: 13, color: 'var(--navy)' }}>When it happened</span>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} style={controlStyle} />
            </div>
          </div>
        )}
        <div className="pp-search" style={{ alignItems: 'flex-start' }}>
          <textarea
            autoFocus={!!attachTo}
            placeholder="Paste the transcript here…"
            value={content}
            onChange={e => setContent(e.target.value)}
            rows={7}
            style={{ flex: 1, border: 'none', outline: 'none', resize: 'none', fontSize: 12.5, lineHeight: 1.5, fontFamily: 'inherit', color: 'var(--navy)', background: 'transparent' }}
          />
        </div>
        {error && <div className="pp-meta" style={{ color: 'var(--red)' }}>{error}</div>}
        <div className="pp-row" style={{ gap: 8 }}>
          <button className="pp-btn pp-ghost" style={{ flex: 1 }} onClick={onClose} disabled={saving}>Cancel</button>
          <button className="pp-btn pp-solid" style={{ flex: 2 }} onClick={submit} disabled={!canSubmit || saving}>
            {saving ? 'Uploading…' : 'Upload & process'}
          </button>
        </div>
      </div>
    </>
  );
}
