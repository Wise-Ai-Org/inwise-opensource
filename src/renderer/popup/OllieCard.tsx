import React, { useCallback, useEffect, useState } from 'react';
import type {
  JiraTicketRow, MorningContent, OllieMoment, OwedItem, PendingJiraApproval, PrepContent, ProcessedContent, TaskRef, WrapUpContent,
} from '../api';
import { api, fmtDueDate, fmtTime, useNav, OLLIE_SLACK_SYNCED_EVENT } from './nav';
import { useReview } from './PopupShell';
import { buildMeetingSlackRecap } from './slack-recap';
import { retrySavedRecording } from './recording-recovery';
import './ollie.css';

// Ollie moments (docs/OLLIE_MOMENTS.md): one proactive card under the date
// strip, plus the inline processed recap on a meeting row. Every value comes
// from the main-process payload; empty sections are omitted.

export const OLLIE_CARD_ID = 'ollie-moment-card';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const hhmm = (ms: number) => fmtTime(new Date(ms));
// Stored `YYYY-MM-DD` strings are local calendar days; `new Date()` would read them as UTC midnight.
const localDay = (value: string | null) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
const shortDate = (value: string) => {
  const d = new Date(localDay(value) as string);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const firstWord = (name: string) => name.trim().split(/\s+/)[0] || name;

function DueChip({ task, lateLabel }: { task: { dueDate: string | null; daysLate: number | null }; lateLabel?: (n: number) => string }) {
  if (task.daysLate) {
    return <span className="ol-chip ol-late">{lateLabel ? lateLabel(task.daysLate) : `Overdue ${task.daysLate}d`}</span>;
  }
  const due = fmtDueDate(localDay(task.dueDate));
  if (!due) return null;
  return <span className={`ol-chip ${due.overdue ? 'ol-late' : ''}`}>{due.label}</span>;
}

function Shell({ kicker, title, subtitle, onDismiss, fail, id, focused, children }: {
  kicker: string;
  title: string;
  subtitle?: string | null;
  onDismiss?: () => void;
  fail?: boolean;
  id?: string;
  focused?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <section id={id} className={`ol-card ${fail ? 'ol-fail' : ''} ${focused ? 'ol-focus' : ''}`} aria-label={kicker} onClick={e => e.stopPropagation()}>
      <div className="ol-head">
        <div className="pp-grow">
          <div className="ol-kicker">{kicker}</div>
          <div className="ol-title">{title}</div>
          {subtitle && <div className="ol-sub">{subtitle}</div>}
        </div>
        {onDismiss && <button className="ol-x" aria-label="Dismiss Ollie card" onClick={onDismiss}>✕</button>}
      </div>
      {children}
    </section>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ol-sec">
      <div className="ol-seclabel">{label}</div>
      <div className="ol-rows">{children}</div>
    </div>
  );
}

function Row({ title, sub, lead, chip, actions, onOpen, strike }: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  lead?: React.ReactNode;
  chip?: React.ReactNode;
  actions?: React.ReactNode;
  onOpen?: () => void;
  strike?: boolean;
}) {
  return (
    <div
      className={`ol-row ${onOpen ? 'ol-clickable' : ''}`}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={onOpen ? e => { if (e.key === 'Enter') onOpen(); } : undefined}
    >
      {lead}
      <div className="ol-row-main">
        <div className={`ol-row-title ${strike ? 'ol-done' : ''}`}>{title}</div>
        {sub && <div className="ol-row-sub">{sub}</div>}
      </div>
      {chip}
      {actions && <div className="ol-actions" onClick={e => e.stopPropagation()}>{actions}</div>}
    </div>
  );
}

/** Runs a card action once, disabling its buttons while it is in flight. */
function useBusy() {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const run = useCallback(async (key: string, fn: () => Promise<unknown>) => {
    setBusy(b => ({ ...b, [key]: true }));
    try { await fn(); } catch { /* the refetch shows the true state */ }
    finally { setBusy(b => ({ ...b, [key]: false })); }
  }, []);
  return { busy, run };
}

/**
 * Jira changes waiting for an OK. Each row names the target ticket and the
 * words from the meeting behind it; Approve / Skip go through the same gate
 * as the Review page.
 */
function ApprovalRows({ rows, onDone }: { rows: PendingJiraApproval[]; onDone: () => void }) {
  const { busy, run } = useBusy();
  const [gone, setGone] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  return (
    <>
      {rows.map(a => {
        const target = a.issueKey ? `${a.issueKey}${a.issueTitle ? ` · ${a.issueTitle}` : ''}` : 'New ticket';
        const settled = gone[a.id];
        return (
          <div key={a.id} className="ol-row ol-stack">
            <div className="ol-row-main">
              <div className="ol-row-title">{a.summary}</div>
              <div className="ol-row-sub">
                {a.url
                  ? <button className="pp-link ol-inline-link" onClick={() => api().openExternal?.(a.url!)}>{target}</button>
                  : target}
                {a.meetingTitle && !a.evidence ? ` · from ${a.meetingTitle}` : ''}
              </div>
              {a.evidence && <div className="ol-quote">“{a.evidence}”</div>}
              {errors[a.id] && <div className="ol-row-sub ol-warn-text">{errors[a.id]}</div>}
            </div>
            <div className="ol-actions" onClick={e => e.stopPropagation()}>
              {settled ? <span className="ol-chip">{settled}</span> : (
                <>
                  <button className="ol-btn ol-primary" disabled={busy[a.id]} onClick={() => run(a.id, async () => {
                    const res = await api().sorApprove?.(a.id);
                    if (res && res.ok === false) setErrors(e => ({ ...e, [a.id]: res.error || 'Jira did not accept the change.' }));
                    else setGone(g => ({ ...g, [a.id]: 'Approved' }));
                    onDone();
                  })}>Approve</button>
                  {a.suggestion && (
                    <button className="ol-btn" disabled={busy[a.id]} onClick={() => run(a.id, async () => {
                      const res = await api().jiraCreateInstead?.(a.id);
                      if (res && res.ok === false) setErrors(e => ({ ...e, [a.id]: res.error || 'Could not create the ticket.' }));
                      else setGone(g => ({ ...g, [a.id]: res?.key ? `Created ${res.key}` : 'Created' }));
                      onDone();
                    })}>Create new</button>
                  )}
                  <button className="ol-btn ol-quiet" disabled={busy[a.id]} onClick={() => run(a.id, async () => { await api().sorReject?.(a.id); setGone(g => ({ ...g, [a.id]: 'Skipped' })); onDone(); })}>Skip</button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

/** Read-only ticket rows; tap opens the issue in Jira. */
function JiraRows({ rows }: { rows: JiraTicketRow[] }) {
  return (
    <>
      {rows.map(r => (
        <Row
          key={`${r.kind}-${r.key}`}
          lead={<span className="ol-key">{r.key}</span>}
          title={r.title}
          sub={[r.owner, r.detail].filter(Boolean).join(' · ')}
          chip={r.kind === 'overdue' || r.kind === 'blocked' ? <span className="ol-chip ol-late">{r.kind === 'blocked' ? 'Blocked' : 'Overdue'}</span> : undefined}
          onOpen={r.url ? () => api().openExternal?.(r.url!) : undefined}
        />
      ))}
    </>
  );
}

// ── Morning ──────────────────────────────────────────────────────────────────

function MorningBody({ m, refresh }: { m: MorningContent; refresh: () => void }) {
  const { push } = useNav();
  const { busy, run } = useBusy();
  const [undone, setUndone] = useState<Record<string, boolean>>({});

  if (m.welcomeBack) {
    const w = m.welcomeBack.wins;
    const lines = [
      w.cleared && `Cleared ${plural(w.cleared.count, 'task')} you hadn't touched recently (bring any back anytime)`,
      w.jiraProgress && `${plural(w.jiraProgress.count, 'Jira story', 'Jira stories')} moved forward while you were out, ${w.jiraProgress.doneCount} now Done`,
      w.meetingsMatched && `Matched ${plural(w.meetingsMatched.count, 'new meeting')} to Jira issues automatically`,
      w.calendarHealthy && `Calendar in sync; ${w.calendarHealthy.upcomingCount} upcoming this week`,
    ].filter(Boolean) as string[];
    if (!lines.length) return null;
    return (
      <Section label="While you were away">
        {lines.map(line => <Row key={line} title={line} />)}
      </Section>
    );
  }

  return (
    <>
      {m.topPriorities.length > 0 && (
        <Section label="Top priorities">
          {m.topPriorities.map(t => (
            <Row
              key={t.taskId}
              lead={<span className="ol-num">{t.rank}</span>}
              title={t.title}
              sub={t.sourceMeetingTitle ? `From ${t.sourceMeetingTitle}` : null}
              chip={<DueChip task={t} />}
              onOpen={() => push({ kind: 'task', id: t.taskId })}
            />
          ))}
        </Section>
      )}
      {m.doneSinceYesterday.length > 0 && (
        <Section label="Done since yesterday">
          {m.doneSinceYesterday.map(t => (
            <Row
              key={t.taskId}
              title={t.title}
              strike={!undone[t.taskId]}
              onOpen={() => push({ kind: 'task', id: t.taskId })}
              actions={undone[t.taskId] ? <span className="ol-chip">Reopened</span> : (
                <button className="ol-btn ol-quiet" disabled={busy[t.taskId]} onClick={() => run(t.taskId, async () => {
                  await api().rejectLikelyDone?.(t.taskId);
                  setUndone(u => ({ ...u, [t.taskId]: true }));
                  refresh();
                })}>Undo</button>
              )}
            />
          ))}
        </Section>
      )}
      {m.jira && (
        <Section label="Your Jira">
          {m.jira.sprintEnding && (
            <div className="ol-warn">
              {m.jira.sprintEnding.name} ends {sprintEnds(m.jira.sprintEnding.endsAt)} with {plural(m.jira.sprintEnding.openCount, 'open ticket')} of yours.
            </div>
          )}
          <JiraRows rows={morningJiraRows(m)} />
        </Section>
      )}
      {m.catchUp.length > 0 && (
        <Section label="Catch up">
          {m.catchUp.map(p => (
            <Row
              key={p.personId}
              title={p.name}
              sub={`${plural(p.weeksSinceMet, 'week')} since you met · waiting on ${p.waitingOn}`}
              onOpen={() => push({ kind: 'person', id: p.personId, name: p.name })}
            />
          ))}
        </Section>
      )}
    </>
  );
}

function sprintEnds(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'soon';
  const sameDay = d.toDateString() === new Date().toDateString();
  return `${sameDay ? 'today' : 'tomorrow'} at ${hhmm(d.getTime())}`;
}

/** Overdue, due today, unanswered mentions, then sprint tickets not already listed. Max 6. */
function morningJiraRows(m: MorningContent): JiraTicketRow[] {
  const j = m.jira;
  if (!j) return [];
  const rows = [...j.overdue, ...j.dueToday, ...j.mentions];
  for (const r of j.sprintEnding?.rows || []) if (!rows.some(x => x.key === r.key)) rows.push(r);
  return rows.slice(0, 6);
}

function morningHeader(m: MorningContent) {
  if (m.welcomeBack) {
    return {
      kicker: 'Welcome back',
      title: m.firstName ? `Welcome back, ${m.firstName}` : 'Welcome back',
      subtitle: `You were away ${plural(m.welcomeBack.gapDays, 'day')}`,
    };
  }
  const counts = [
    m.meetingCount ? plural(m.meetingCount, 'meeting') : null,
    m.priorityCount ? plural(m.priorityCount, 'priority', 'priorities') : null,
    m.overduePromiseCount ? plural(m.overduePromiseCount, 'overdue promise') : null,
  ].filter(Boolean).join(' · ');
  return {
    kicker: 'Ollie planned your day',
    title: m.firstName ? `Good morning, ${m.firstName}` : 'Good morning',
    subtitle: counts || 'Nothing scheduled or due today.',
  };
}

// ── Prep ─────────────────────────────────────────────────────────────────────

function PrepBody({ p, refresh }: { p: PrepContent; refresh: () => void }) {
  const { push } = useNav();
  const review = useReview();
  const [armed, setArmed] = useState(p.recordArmed);
  const [copied, setCopied] = useState(false);
  const { busy, run } = useBusy();
  useEffect(() => setArmed(p.recordArmed), [p.recordArmed]);

  // Once the meeting has started, the button reflects the recording itself:
  // Recording while one runs, Record now if this meeting is still unrecorded.
  const started = Date.now() >= p.startTime;
  const [recordingNow, setRecordingNow] = useState(false);
  const [canRecordNow, setCanRecordNow] = useState(false);
  useEffect(() => {
    if (!started) return;
    const a = api();
    const check = () => {
      a.getRecordingState?.().then((r: any) => setRecordingNow(!!r?.active)).catch(() => {});
      a.welcomeBackLiveMeeting?.().then((m: any) => setCanRecordNow(m?.id === p.eventId)).catch(() => {});
    };
    check();
    const timer = window.setInterval(check, 15_000);
    a.on?.('recording:status', check);
    return () => { window.clearInterval(timer); a.off?.('recording:status', check); };
  }, [started, p.eventId]);

  const openItem = (item: OwedItem) => {
    if (item.taskId) push({ kind: 'task', id: item.taskId });
    else if (item.meetingId) push({ kind: 'meeting', id: item.meetingId });
  };
  const owedRow = (item: OwedItem, i: number, late: (n: number) => string) => (
    <Row
      key={`${item.taskId || item.meetingId || ''}-${i}`}
      title={item.text}
      chip={item.daysLate ? <span className="ol-chip ol-late">{late(item.daysLate)}</span> : <DueChip task={item} />}
      onOpen={item.taskId || item.meetingId ? () => openItem(item) : undefined}
    />
  );

  return (
    <>
      {p.draftAgenda && p.draftAgenda.length > 0 && (
        <Section label="Ollie's draft agenda">
          {p.draftAgenda.map((line, i) => (
            <Row key={i} lead={<span className="ol-num">{i + 1}</span>} title={line} />
          ))}
        </Section>
      )}
      {p.owes.map(o => (
        <React.Fragment key={o.personId || o.name}>
          {o.owesYou.length > 0 && (
            <Section label={`${firstWord(o.name)} owes you`}>
              {o.owesYou.map((item, i) => owedRow(item, i, n => `${plural(n, 'day')} late`))}
            </Section>
          )}
          {o.youOwe.length > 0 && (
            <Section label={`You owe ${firstWord(o.name)}`}>
              {o.youOwe.map((item, i) => owedRow(item, i, () => 'Overdue'))}
            </Section>
          )}
        </React.Fragment>
      ))}
      {p.jira && p.jira.rows.length > 0 && (
        <Section label="Their Jira">
          <JiraRows rows={p.jira.rows} />
        </Section>
      )}
      {p.pendingApprovals.length > 0 && (
        <Section label="Waiting on your OK">
          <ApprovalRows rows={p.pendingApprovals} onDone={() => { review.reload(); refresh(); }} />
        </Section>
      )}
      <div className="ol-footer">
        {!started && (
          <button
            className={`ol-btn ${armed ? '' : 'ol-primary'}`}
            disabled={busy.arm}
            onClick={() => run('arm', async () => {
              const res = await api().ollieSetRecordAtStart?.(p.eventId, !armed);
              setArmed(!!res?.armed);
            })}
          >
            {armed ? 'Recording at start ✓' : '● Record when it starts'}
          </button>
        )}
        {started && recordingNow && <span className="ol-btn" aria-live="polite">● Recording</span>}
        {started && !recordingNow && canRecordNow && (
          <button
            className="ol-btn ol-primary"
            disabled={busy.rec}
            onClick={() => run('rec', async () => {
              await api().startRecording?.(p.title, p.eventId);
              setRecordingNow(true);
            })}
          >● Record now</button>
        )}
        {p.draftAgenda && p.draftAgenda.length > 0 && (
          <button className="ol-btn" onClick={async () => {
            try {
              await navigator.clipboard.writeText(p.draftAgenda!.map((line, i) => `${i + 1}. ${line}`).join('\n'));
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            } catch { /* clipboard unavailable */ }
          }}>{copied ? 'Copied' : 'Copy agenda'}</button>
        )}
      </div>
    </>
  );
}

function prepHeader(p: PrepContent) {
  const when = p.minutesUntil > 0 ? `in ${p.minutesUntil} min` : 'starting now';
  const inProgress = Date.now() >= p.startTime;
  return {
    kicker: inProgress ? `Now · ${hhmm(p.startTime)} to ${hhmm(p.endTime)}` : `Up next · ${hhmm(p.startTime)}, ${when}`,
    title: p.title,
    subtitle: p.lastMet ? `Last met ${shortDate(p.lastMet.date)} · ${p.lastMet.title}` : null,
  };
}

// ── Wrap-up ──────────────────────────────────────────────────────────────────

function WrapBody({ w, refresh }: { w: WrapUpContent; refresh: () => void }) {
  const { push } = useNav();
  const { busy, run } = useBusy();
  const [done, setDone] = useState<Record<string, string>>({});
  const [channelNames, setChannelNames] = useState<Record<string, string>>({});
  const t = w.tomorrow;

  useEffect(() => {
    if (!w.slackToday.length) return;
    api().slackListChannels?.().then((res: any) => {
      const list = Array.isArray(res) ? res : Array.isArray(res?.channels) ? res.channels : [];
      const names: Record<string, string> = {};
      for (const c of list) if (c?.id && c?.name) names[c.id] = c.name;
      setChannelNames(names);
    }).catch(() => {});
  }, [w.slackToday.length]);

  const openTask = (ref: TaskRef) => () => push({ kind: 'task', id: ref.taskId });
  const hasTomorrow = !!(t.firstMeeting || t.overdueWithAttendees.length || t.crunch || t.cancelledToday.length);

  return (
    <>
      {hasTomorrow && (
        <Section label="Tomorrow">
          {t.firstMeeting && (
            <Row
              lead={<span className="ol-num" style={{ width: 'auto' }}>{hhmm(t.firstMeeting.startTime)}</span>}
              title={t.firstMeeting.title}
              sub={[
                t.firstMeeting.agendaDrafted ? 'Agenda drafted' : null,
                t.firstMeeting.tasksDueBefore.length ? `${plural(t.firstMeeting.tasksDueBefore.length, 'task')} due before it` : null,
              ].filter(Boolean).join(' · ') || null}
            />
          )}
          {t.overdueWithAttendees.map(x => (
            <Row key={x.taskId} title={x.title} sub={`With ${x.attendee}`} chip={<DueChip task={x} />} onOpen={openTask(x)} />
          ))}
          {t.crunch && (
            <div className="ol-warn">
              No free time from {hhmm(t.crunch.from)} to {hhmm(t.crunch.to)} tomorrow.
              {t.crunch.topOverdue ? ` Do "${t.crunch.topOverdue.title}" tonight or move it.` : ''}
            </div>
          )}
          {t.cancelledToday.map(c => (
            <div key={c.eventId} className="ol-warn">
              {c.title} ({hhmm(c.startTime)}) was cancelled.
              {c.tasks.length ? ` ${plural(c.tasks.length, 'task')} were due for it: ${c.tasks.map(x => x.title).join('; ')}.` : ''}
            </div>
          ))}
        </Section>
      )}
      {w.goneQuiet.length > 0 && (
        <Section label="Gone quiet">
          {w.goneQuiet.map(g => (
            <Row
              key={g.taskId}
              title={g.title}
              sub={[g.commitmentToOther ? 'Promised to someone' : null, g.lastActivityAt ? `Quiet since ${shortDate(g.lastActivityAt)}` : null].filter(Boolean).join(' · ') || null}
              onOpen={openTask(g)}
              actions={done[g.taskId] ? <span className="ol-chip">{done[g.taskId]}</span> : (
                <button className="ol-btn" disabled={busy[g.taskId]} onClick={() => run(g.taskId, async () => {
                  await api().ollieAddToTomorrow?.(g.taskId);
                  setDone(d => ({ ...d, [g.taskId]: 'Due tomorrow' }));
                })}>Add to tomorrow</button>
              )}
            />
          ))}
        </Section>
      )}
      {w.slackToday.length > 0 && (
        <Section label="Came in from Slack">
          {w.slackToday.map(s => (
            <Row
              key={s.channelId}
              title={s.channelId === 'unknown' ? 'Other channels' : `#${channelNames[s.channelId] || s.channelId}`}
              sub={[plural(s.threadCount, 'thread'), s.taskCount ? plural(s.taskCount, 'task') : null, s.decisionCount ? plural(s.decisionCount, 'decision') : null].filter(Boolean).join(' · ')}
            />
          ))}
        </Section>
      )}
      {(w.snoozedToday.length > 0 || w.receipts.length > 0) && (
        <Section label="Cleaned up">
          {w.snoozedToday.map(s => (
            <Row
              key={s.taskId}
              title={s.title}
              sub="Snoozed as stale"
              onOpen={openTask(s)}
              actions={done[s.taskId] ? <span className="ol-chip">{done[s.taskId]}</span> : (
                <button className="ol-btn ol-quiet" disabled={busy[s.taskId]} onClick={() => run(s.taskId, async () => {
                  await api().bringBackTask?.(s.taskId);
                  setDone(d => ({ ...d, [s.taskId]: 'Back' }));
                  refresh();
                })}>Undo</button>
              )}
            />
          ))}
          {w.receipts.map(r => (
            <Row key={r.executionId} title={r.title} sub={[r.client, r.summary || r.status].filter(Boolean).join(' · ')} />
          ))}
        </Section>
      )}
      {w.jira && (
        <Section label="Jira today">
          {w.jira.changedToday.map(c => (
            <Row
              key={c.id}
              lead={<span className="ol-key">{c.issueKey}</span>}
              title={c.summary}
              sub="From a meeting today"
              onOpen={c.url ? () => api().openExternal?.(c.url!) : undefined}
            />
          ))}
          {w.jira.waitingCount > 0 && (
            <Row
              title={`${plural(w.jira.waitingCount, 'Jira change')} ${w.jira.waitingCount === 1 ? 'is' : 'are'} waiting for your OK`}
              actions={<button className="ol-btn" onClick={() => push({ kind: 'review', focus: 'approvals' })}>Open review</button>}
            />
          )}
          <JiraRows rows={w.jira.staleDiscussed} />
        </Section>
      )}
      {w.needsRetry.length > 0 && (
        <Section label="Still needs a retry">
          {w.needsRetry.map(n => (
            <RetryRow key={n.meetingId} meetingId={n.meetingId} title={n.title} sub={[shortDate(n.date), n.message].filter(Boolean).join(' · ')} onDone={refresh} />
          ))}
        </Section>
      )}
    </>
  );
}

function RetryRow({ meetingId, title, sub, onDone }: { meetingId: string; title: string; sub: string; onDone: () => void }) {
  const { push } = useNav();
  const { busy, run } = useBusy();
  const [note, setNote] = useState<string | null>(null);
  return (
    <Row
      title={title}
      sub={note || sub}
      onOpen={() => push({ kind: 'meeting', id: meetingId })}
      actions={<RecoveryButtons meetingId={meetingId} busy={busy} run={run} onNote={setNote} onDone={onDone} />}
    />
  );
}

function RecoveryButtons({ meetingId, busy, run, onNote, onDone }: {
  meetingId: string;
  busy: Record<string, boolean>;
  run: (key: string, fn: () => Promise<unknown>) => Promise<void>;
  onNote: (note: string) => void;
  onDone: () => void;
}) {
  return (
    <>
      <button className="ol-btn ol-primary" disabled={busy.retry} onClick={() => run('retry', async () => {
        try {
          onNote('Retrying…');
          await retrySavedRecording(meetingId);
          onNote('Processing again. This card updates when it finishes.');
        } catch (e: any) {
          onNote(e?.message || 'Retry failed. The audio is still saved.');
        }
        onDone();
      })}>Retry</button>
      <button className="ol-btn" disabled={busy.export} onClick={() => run('export', async () => {
        const res = await api().exportRecording?.(meetingId);
        if (res?.error) onNote(res.error);
        else if (res?.ok) onNote('Audio exported.');
      })}>Export audio</button>
    </>
  );
}

function wrapHeader(w: WrapUpContent) {
  return {
    kicker: 'Day wrapped',
    title: w.firstName ? `Ready for tomorrow, ${w.firstName}` : 'Ready for tomorrow',
    subtitle: [plural(w.today.meetingCount, 'meeting'), `${plural(w.today.tasksFound, 'task')} found`, plural(w.today.decisions, 'decision')].join(' · '),
  };
}

// ── The card under the date strip ────────────────────────────────────────────

export function OllieMomentCard({ revision, focused }: { revision: number; focused: boolean }) {
  const [moment, setMoment] = useState<OllieMoment | null>(null);
  const [rev, setRev] = useState(0);
  const refresh = useCallback(() => setRev(r => r + 1), []);

  useEffect(() => {
    let cancelled = false;
    api().getOllieMoment?.().then((next: OllieMoment | null) => {
      if (cancelled) return;
      setMoment(next || null);
      const syncedAt = next?.kind === 'wrap' ? next.wrapUp.slackSyncedAt : null;
      window.dispatchEvent(new CustomEvent(OLLIE_SLACK_SYNCED_EVENT, { detail: { at: syncedAt } }));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [revision, rev]);

  if (!moment) return null;
  const dismiss = async () => {
    setMoment(null);
    try { await api().dismissOllieMoment?.(moment.key); } catch { /* refetch restores it */ }
  };

  if (moment.kind === 'prep') {
    return <Shell id={OLLIE_CARD_ID} focused={focused} onDismiss={dismiss} {...prepHeader(moment.prep)}><PrepBody p={moment.prep} refresh={refresh} /></Shell>;
  }
  if (moment.kind === 'wrap') {
    return <Shell id={OLLIE_CARD_ID} focused={focused} onDismiss={dismiss} {...wrapHeader(moment.wrapUp)}><WrapBody w={moment.wrapUp} refresh={refresh} /></Shell>;
  }
  return <Shell id={OLLIE_CARD_ID} focused={focused} onDismiss={dismiss} {...morningHeader(moment.morning)}><MorningBody m={moment.morning} refresh={refresh} /></Shell>;
}

// ── Inline processed recap on a meeting row ──────────────────────────────────

const MAX_TASK_ROWS = 5;

/** Shows when there is something to act on, the meeting failed, or `always` (latest processed meeting). */
export function ProcessedRecap({ meetingId, revision, always }: { meetingId: string; revision: number; always: boolean }) {
  const { push } = useNav();
  const review = useReview();
  const [content, setContent] = useState<ProcessedContent | null>(null);
  const [rev, setRev] = useState(0);
  const refresh = useCallback(() => { setRev(r => r + 1); review.reload(); }, [review]);
  const { busy, run } = useBusy();
  const [taskState, setTaskState] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([]);
  const [channelId, setChannelId] = useState('');
  const [slackResult, setSlackResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api().getOllieProcessed?.(meetingId).then((next: ProcessedContent | null) => {
      if (!cancelled) setContent(next || null);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [meetingId, revision, rev]);

  const slackConnected = !!content?.slackConnected && content.status !== 'failed';
  useEffect(() => {
    if (!slackConnected) return;
    api().slackListWriteChannels?.().then((res: any) => {
      if (!res?.ok) return;
      const list = res.channels ?? [];
      setChannels(list);
      setChannelId(list[0]?.id ?? '');
    }).catch(() => {});
  }, [slackConnected]);

  if (!content) return null;

  if (content.status === 'failed' || content.failure) {
    const f = content.failure;
    return (
      <Shell
        fail
        kicker="Needs a retry"
        title={f?.audioSaved ? "Couldn't process this meeting. The audio is saved." : "Couldn't process this meeting."}
        subtitle={note || f?.message || null}
      >
        {f?.audioSaved && (
          <div className="ol-footer">
            <RecoveryButtons meetingId={meetingId} busy={busy} run={run} onNote={setNote} onDone={refresh} />
          </div>
        )}
      </Shell>
    );
  }

  const pendingTasks = content.tasks.filter(t => t.approvalStatus === 'pending' || t.duplicateOf);
  const jiraPending = content.jira?.pending ?? [];
  const actionable = pendingTasks.length > 0 || jiraPending.length > 0 || !!content.patchyAudio;
  if (!actionable && !always) return null;
  if (content.taskCount === 0 && content.decisionCount === 0 && !actionable) return null;

  const span = content.startedAt
    ? ` · ${hhmm(content.startedAt)}${content.endedAt ? `–${hhmm(content.endedAt)}` : ''}`
    : '';
  const shownTasks = content.tasks.slice(0, MAX_TASK_ROWS);
  const setTask = (id: string, label: string) => setTaskState(s => ({ ...s, [id]: label }));
  const channelName = channels.find(c => c.id === channelId)?.name;

  const postRecap = () => run('slack', async () => {
    setSlackResult(null);
    try {
      const meeting = await api().getMeeting?.(meetingId);
      const result = await api().slackPostOllieNote?.(channelId, buildMeetingSlackRecap(meeting || {}));
      setSlackResult(result?.ok ? { ok: true, message: 'Recap posted to Slack.' } : { ok: false, message: result?.error || 'Slack did not accept the recap.' });
    } catch (e: any) {
      setSlackResult({ ok: false, message: e?.message || 'Slack did not accept the recap.' });
    }
  });

  return (
    <Shell
      kicker={`Processed${span}`}
      title={`Inwise found ${plural(content.taskCount, 'task')} and ${plural(content.decisionCount, 'decision')}`}
    >
      {content.patchyAudio && (
        <div className="ol-warn">
          Audio was patchy{content.patchyAudio.reasons.length ? `: ${content.patchyAudio.reasons.join('; ')}` : ''}. Check the transcript before trusting these.
        </div>
      )}
      {shownTasks.length > 0 && (
        <Section label="Tasks found">
          {shownTasks.map(t => {
            const settled = taskState[t.taskId];
            let actions: React.ReactNode = null;
            if (settled) actions = <span className="ol-chip">{settled}</span>;
            else if (t.duplicateOf) {
              actions = (
                <>
                  <button className="ol-btn" disabled={busy[t.taskId]} onClick={() => run(t.taskId, async () => {
                    await api().dedupResolvePending?.(t.taskId, 'same'); setTask(t.taskId, 'Merged'); refresh();
                  })}>Merge</button>
                  <button className="ol-btn ol-quiet" disabled={busy[t.taskId]} onClick={() => run(t.taskId, async () => {
                    await api().dedupResolvePending?.(t.taskId, 'new'); setTask(t.taskId, 'Kept both'); refresh();
                  })}>Keep both</button>
                </>
              );
            } else if (t.approvalStatus === 'pending') {
              actions = (
                <>
                  <button className="ol-btn" disabled={busy[t.taskId]} onClick={() => run(t.taskId, async () => {
                    await api().updateTask?.(t.taskId, { approval: { status: 'approved' } }); setTask(t.taskId, 'Kept'); refresh();
                  })}>Keep</button>
                  <button className="ol-btn ol-quiet" disabled={busy[t.taskId]} onClick={() => run(t.taskId, async () => {
                    await api().updateTask?.(t.taskId, { approval: { status: 'rejected' } }); setTask(t.taskId, 'Skipped'); refresh();
                  })}>Skip</button>
                </>
              );
            }
            const sub = t.duplicateOf
              ? `Looks like "${t.duplicateOf.title}"${t.duplicateOf.wasDone ? ' (done)' : ''}`
              : t.owner || null;
            return (
              <Row
                key={t.taskId}
                title={t.title}
                sub={sub}
                chip={actions ? undefined : <DueChip task={{ dueDate: t.dueDate, daysLate: null }} />}
                actions={actions}
                onOpen={() => push({ kind: 'task', id: t.taskId })}
              />
            );
          })}
          {content.tasks.length > MAX_TASK_ROWS && (
            <div className="ol-note">{plural(content.tasks.length - MAX_TASK_ROWS, 'more task')} in the meeting.</div>
          )}
        </Section>
      )}
      {content.decisions.length > 0 && (
        <Section label={content.decisions.length === 1 ? 'Decision' : 'Decisions'}>
          {content.decisions.map((d, i) => <Row key={i} title={d} />)}
        </Section>
      )}
      {content.jira && (content.jira.pushedCount > 0 || content.jira.failedCount > 0 || jiraPending.length > 0) && (
        <Section label="Jira from this meeting">
          {(content.jira.pushedCount > 0 || content.jira.failedCount > 0) && (
            <div className="ol-receipt">
              {content.jira.pushedCount > 0 && <>Pushed {plural(content.jira.pushedCount, 'update')}{content.jira.pushed.length ? ': ' : '.'}</>}
              {content.jira.pushed.map((p, i) => (
                <React.Fragment key={p.id}>
                  {i > 0 && ', '}
                  {p.url ? <button className="pp-link" style={{ padding: 0 }} onClick={() => api().openExternal?.(p.url!)}>{p.issueKey}</button> : p.issueKey}
                </React.Fragment>
              ))}
              {content.jira.failedCount > 0 && content.jira.failed.length === 0 && <span style={{ color: '#b4570b' }}>{content.jira.pushedCount > 0 ? ' · ' : ''}{plural(content.jira.failedCount, 'update')} failed</span>}
            </div>
          )}
          {content.jira.failed.map(f => (
            <div key={f.id} className="ol-warn">{f.message}</div>
          ))}
          {jiraPending.length > 0 && <ApprovalRows rows={jiraPending} onDone={refresh} />}
        </Section>
      )}
      <div className="ol-footer">
        {slackConnected && channels.length > 0 && (
          <>
            {channels.length > 1 && (
              <select className="ol-select" aria-label="Slack channel" value={channelId} onChange={e => setChannelId(e.target.value)}>
                {channels.map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}
              </select>
            )}
            <button className="ol-btn ol-primary" disabled={busy.slack || !channelId} onClick={postRecap}>
              {busy.slack ? 'Posting…' : channels.length > 1 ? 'Post recap' : `Post recap to #${channelName}`}
            </button>
          </>
        )}
        <button className="ol-btn ol-quiet" onClick={() => push({ kind: 'meeting', id: meetingId, title: content.title })}>Open meeting ›</button>
      </div>
      {slackResult && <div className={slackResult.ok ? 'ol-note' : 'ol-warn'}>{slackResult.message}</div>}
    </Shell>
  );
}
