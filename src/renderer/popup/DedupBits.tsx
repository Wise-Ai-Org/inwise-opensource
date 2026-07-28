import React, { useEffect, useState } from 'react';
import { api } from './nav';

// Shared task-dedup UI pieces (task-dedup PRD US-007 / US-009 / US-010 / US-014).
// Built from the existing popup card + chip primitives — no new visual language.

export interface DedupSuggestion {
  candidateTaskId: string;
  candidateTitle: string;
  wasDone: boolean;
  confidence: number;
  retrievalScore: number;
  model: string;
}

/** "Matched using your key · Claude Haiku" — the OSS transparency line. */
export function MatchAttribution({ model }: { model: string }) {
  return (
    <div className="pp-meta" style={{ marginTop: 8, fontSize: 11 }}>
      Matched using your key · {model}
    </div>
  );
}

function MeetingGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="6" width="13" height="12" rx="2" />
      <path d="M15 10.5 22 7v10l-7-3.5z" />
    </svg>
  );
}

function NoteGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" stroke="none" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

/**
 * Ask-band confirm (US-007). Two actions, no form. A recently-done candidate
 * asks the reopen question instead, with the single combined "Reopen and
 * merge" action (OQ5).
 */
export function DedupConfirmCard({
  suggestion,
  newTitle,
  excerpt,
  busy,
  onSame,
  onNew,
}: {
  suggestion: DedupSuggestion;
  newTitle: string;
  excerpt?: string;
  busy?: boolean;
  onSame: () => void;
  onNew: () => void;
}) {
  const sameLabel = suggestion.wasDone ? 'Reopen and merge' : 'Same task';
  const newLabel = suggestion.wasDone ? 'Start a new task' : 'New task';
  return (
    <div className="pp-card" data-testid="dedup-confirm">
      <div className="pp-row" style={{ marginBottom: 6 }}>
        <span className={`pp-chip ${suggestion.wasDone ? 'pp-amber' : 'pp-teal'}`}>
          {suggestion.wasDone ? 'This looks done' : 'Might be the same task'}
        </span>
        <span className="pp-grow" />
        <span className="pp-meta">{Math.round(suggestion.confidence)}% sure</span>
      </div>

      <div className="pp-title-sm">{newTitle}</div>
      {excerpt && excerpt !== newTitle && (
        <div
          className="pp-meta"
          style={{ marginTop: 4, paddingLeft: 8, borderLeft: '3px solid var(--pp-teal-line)', fontStyle: 'italic', lineHeight: 1.5 }}
        >
          “{excerpt}”
        </div>
      )}

      <div className="pp-meta" style={{ marginTop: 8 }}>
        {suggestion.wasDone ? 'Looks like work you already finished:' : 'Looks like this open task:'}
      </div>
      <div className="pp-title-sm" style={{ fontSize: 13, marginTop: 2 }}>{suggestion.candidateTitle}</div>

      <div className="pp-row" style={{ marginTop: 9, gap: 8 }}>
        <button className="pp-btn pp-solid" style={{ flex: 1, padding: '6px 0' }} disabled={busy} onClick={onSame}>
          {sameLabel}
        </button>
        <button className="pp-btn pp-ghost" style={{ flex: 1, padding: '6px 0' }} disabled={busy} onClick={onNew}>
          {newLabel}
        </button>
      </div>

      <MatchAttribution model={suggestion.model} />
    </div>
  );
}

export interface ThreadEntry {
  id: string;
  sourceType: 'meeting' | 'voice_note';
  sourceId: string | null;
  sourceTitle: string;
  excerpt: string;
  occurredAt: string;
  canSplit: boolean;
}

function fmtMentionDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * Mention thread (US-009). Renders nothing at all when a task has fewer than
 * two mentions — the common case keeps exactly today's chrome.
 */
export function MentionThread({ taskId, onChanged }: { taskId: string; onChanged?: () => void }) {
  const [entries, setEntries] = useState<ThreadEntry[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = React.useCallback(() => {
    api().dedupGetMentionThread?.(taskId)
      .then((rows: ThreadEntry[]) => setEntries(Array.isArray(rows) ? rows : []))
      .catch(() => setEntries([]));
  }, [taskId]);

  useEffect(() => { load(); }, [load]);

  const split = async (mentionId: string) => {
    setBusyId(mentionId);
    try {
      await api().dedupUndoSplit?.(taskId, mentionId);
      load();
      onChanged?.();
    } finally {
      setBusyId(null);
    }
  };

  if (entries.length === 0) return null;

  return (
    <>
      <div className="pp-seclabel">Came up {entries.length} times</div>
      <div className="pp-listcard" data-testid="mention-thread">
        {entries.map((e, i) => (
          <div
            key={e.id}
            style={{ padding: '9px 12px', borderTop: i === 0 ? 'none' : '1px solid var(--slate-100)' }}
            data-testid="mention-entry"
          >
            <div className="pp-row" style={{ gap: 6 }}>
              <span style={{ color: 'var(--teal)', lineHeight: 0 }}>
                {e.sourceType === 'voice_note' ? <NoteGlyph /> : <MeetingGlyph />}
              </span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--navy)' }}>{e.sourceTitle}</span>
              <span className="pp-grow" />
              <span className="pp-meta">{fmtMentionDate(e.occurredAt)}</span>
            </div>
            {e.excerpt && (
              <div
                className="pp-meta"
                style={{ marginTop: 4, paddingLeft: 8, borderLeft: '3px solid var(--pp-teal-line)', fontStyle: 'italic', lineHeight: 1.5 }}
              >
                “{e.excerpt}”
              </div>
            )}
            {e.canSplit && (
              <button
                className="pp-quiet-action"
                style={{ marginTop: 4, padding: 0 }}
                disabled={busyId === e.id}
                onClick={() => split(e.id)}
              >
                {busyId === e.id ? 'Splitting…' : 'Not the same — split out'}
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * "Raised N× this week" + one-step Bump priority (US-014). Priority never
 * changes without the explicit tap; dismissing hides the chip until the
 * mention count grows again.
 */
export function RepetitionNudge({
  taskId,
  count,
  onChanged,
}: {
  taskId: string;
  count: number;
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  if (gone) return null;

  const bump = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await api().dedupBumpPriority?.(taskId);
      setGone(true);
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await api().dedupDismissNudge?.(taskId);
      setGone(true);
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="pp-row" style={{ gap: 6, flexWrap: 'wrap' }} data-testid="repetition-nudge">
      <span className="pp-chip pp-amber">Raised {count}× this week</span>
      <button className="pp-chip pp-teal" disabled={busy} onClick={bump}>Bump priority</button>
      <button className="pp-quiet-action" style={{ padding: 0, fontSize: 11 }} disabled={busy} onClick={dismiss}>
        Dismiss
      </button>
    </span>
  );
}
