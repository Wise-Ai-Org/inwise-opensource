/**
 * Payload shapes for Ollie moments (docs/OLLIE_MOMENTS.md). Type-only and
 * import-free so the renderer can `import type` it without pulling in any
 * main-process module. Timestamps are epoch milliseconds unless the field name
 * ends in `Key` (local `YYYY-MM-DD`) or the value is a stored task/meeting
 * date string passed through unchanged.
 */

export type MorningMode = 'window' | 'tray' | 'off';
export type NotifyMode = 'notify' | 'tray' | 'off';
export type PrepLeadMinutes = 5 | 10 | 15;

export interface NotificationSettings {
  /** Window = current daily-plan window + tray card; Tray only = card only; Off = neither. */
  morning: MorningMode;
  /** notify = card + OS notification at start - leadMinutes; tray = card only; off = neither. */
  prep: { mode: NotifyMode; leadMinutes: PrepLeadMinutes };
  processed: NotifyMode;
  wrapUp: NotifyMode;
  /** Always true; not editable. Present so the settings UI can render it. */
  recordingProblems: true;
}

export type OllieMomentKind = 'prep' | 'wrap' | 'morning';

export interface TaskRef {
  taskId: string;
  title: string;
  dueDate: string | null;
  /** Whole days past due (>= 1) when overdue, else null. */
  daysLate: number | null;
}

export interface PriorityItem extends TaskRef {
  rank: number;
  score: number;
  sourceMeetingId: string | null;
  sourceMeetingTitle: string | null;
}

export interface CatchUpPerson {
  personId: string;
  name: string;
  daysSinceMet: number;
  weeksSinceMet: number;
  /** Text of the most relevant thing the user owes this person. */
  waitingOn: string;
  waitingCount: number;
}

export interface WelcomeBackContent {
  gapDays: number;
  wins: {
    cleared?: { count: number; sampleTitles: string[] };
    jiraProgress?: { count: number; doneCount: number };
    meetingsMatched?: { count: number };
    calendarHealthy?: { upcomingCount: number };
  };
  ask?: { kind: 'contradiction' | 'overdueWithSignal' | 'launchAtStartupOffer'; payload: any };
}

export interface MorningContent {
  firstName: string;
  meetingCount: number;
  priorityCount: number;
  overduePromiseCount: number;
  topPriorities: PriorityItem[];
  /** Tasks flagged done by task-completion inference since the previous local day start. Undo = rejectLikelyDone(taskId). */
  doneSinceYesterday: TaskRef[];
  catchUp: CatchUpPerson[];
  /** Present on the first day back after a gap; the card renders this instead of the morning sections. */
  welcomeBack: WelcomeBackContent | null;
  /** "Your Jira": null when nothing to show or Jira is not connected. */
  jira: MorningJira | null;
}

export interface OwedItem {
  /** 'task' rows have a taskId; 'commitment' rows come from meeting insights. */
  kind: 'task' | 'commitment';
  taskId: string | null;
  meetingId: string | null;
  text: string;
  dueDate: string | null;
  daysLate: number | null;
}

export interface AttendeeOwes {
  /** Display name derived from the attendee / People record. */
  name: string;
  personId: string | null;
  owesYou: OwedItem[];
  youOwe: OwedItem[];
}

export interface PendingJiraApproval {
  /** sor-writes / sor-pending-approvals id. Approve = sorApprove(id); Skip = sorReject(id). */
  id: string;
  operation: 'create' | 'update' | 'transition' | 'comment';
  summary: string;
  issueKey: string | null;
  meetingId: string | null;
  meetingTitle: string | null;
  createdAt: string;
  /** Target ticket title when known. */
  issueTitle: string | null;
  /** Short quote from the meeting behind the change. */
  evidence: string | null;
  /** "Update PILOT-42 instead?" when Inwise thinks the work already has a ticket. */
  suggestion: string | null;
  /** Ticket intent from the meeting: done, due_moved, decision, new. */
  intent: string | null;
  /** 0..1, how sure Inwise is about the change. */
  confidence: number | null;
  /** Link to the target ticket, when there is one. */
  url: string | null;
}

/** One Jira ticket row in an Ollie card. Tap opens `url`. */
export interface JiraTicketRow {
  key: string;
  title: string;
  url: string | null;
  /** Plain one-line reason the row is here ("Blocked 4 days by OPS-1"). */
  detail: string;
  kind: 'blocked' | 'moved' | 'stale' | 'yours' | 'due_today' | 'overdue' | 'sprint' | 'mention';
  /** Assignee display name, when the row is about someone else's ticket. */
  owner: string | null;
}

export interface PrepJira {
  /** Max 4 rows: blocked, yours that involve them, moved since you last met, quiet 7+ days. */
  rows: JiraTicketRow[];
}

export interface MorningJira {
  dueToday: JiraTicketRow[];
  overdue: JiraTicketRow[];
  /** The active sprint ends within a day and still has your open tickets. */
  sprintEnding: { name: string; endsAt: string; openCount: number; rows: JiraTicketRow[] } | null;
  /** @mentions of you newer than your last comment on that ticket. */
  mentions: JiraTicketRow[];
}

export interface WrapJira {
  /** What Inwise changed in Jira today from meetings (write log). */
  changedToday: { id: string; issueKey: string; url: string | null; operation: string; summary: string }[];
  /** Jira changes still waiting for your OK (opens Review). */
  waitingCount: number;
  /** Tickets discussed today with no Jira update for 7+ days. */
  staleDiscussed: JiraTicketRow[];
}

export interface PrepContent {
  eventId: string;
  title: string;
  startTime: number;
  endTime: number;
  minutesUntil: number;
  attendees: string[];
  lastMet: { meetingId: string; title: string; date: string } | null;
  /** Agenda drafted earlier this session by the daily plan; null when none was drafted. */
  draftAgenda: string[] | null;
  owes: AttendeeOwes[];
  pendingApprovals: PendingJiraApproval[];
  /** True when "Record when it starts" is armed for this event. */
  recordArmed: boolean;
  /** "Their Jira": null when nothing to show or Jira is not connected. */
  jira: PrepJira | null;
}

export interface ProcessedTask {
  taskId: string;
  title: string;
  owner: string | null;
  dueDate: string | null;
  /** 'pending' rows get Keep / Skip (updateTask approval). */
  approvalStatus: string;
  /** Possible duplicate. Merge = dedupResolvePending(taskId,'same'); Keep both = (taskId,'new'). */
  duplicateOf: { taskId: string; title: string; wasDone: boolean } | null;
}

export interface ProcessedContent {
  meetingId: string;
  title: string;
  source: string;
  status: 'processed' | 'needs_review' | 'failed';
  startedAt: number | null;
  endedAt: number | null;
  taskCount: number;
  decisionCount: number;
  tasks: ProcessedTask[];
  decisions: string[];
  /** Transcription-quality reasons when audio was patchy; null when clean. */
  patchyAudio: { reasons: string[] } | null;
  jira: {
    pushedCount: number;
    failedCount: number;
    pushed: { id: string; issueKey: string; url: string | null; operation: string }[];
    pending: PendingJiraApproval[];
    /** Failed writes with the reason ("PILOT-42 has no transition to Done"). */
    failed: { id: string; issueKey: string | null; operation: string; message: string }[];
  } | null;
  /** status === 'failed' only. Retry = retryRecording(meetingId); Export = exportRecording(meetingId). */
  failure: { message: string; stage: string | null; audioSaved: boolean } | null;
  slackConnected: boolean;
}

export interface TomorrowContent {
  firstMeeting: {
    eventId: string;
    title: string;
    startTime: number;
    agendaDrafted: boolean;
    tasksDueBefore: TaskRef[];
  } | null;
  overdueWithAttendees: (TaskRef & { attendee: string })[];
  crunch: { from: number; to: number; topOverdue: TaskRef | null } | null;
  cancelledToday: { eventId: string; title: string; startTime: number; tasks: TaskRef[] }[];
}

export interface WrapUpContent {
  firstName: string;
  today: { meetingCount: number; tasksFound: number; decisions: number };
  tomorrow: TomorrowContent;
  /** Max 3. Add to tomorrow = ollieAddToTomorrow(taskId). */
  goneQuiet: (TaskRef & { score: number; commitmentToOther: boolean; lastActivityAt: string | null })[];
  slackToday: { channelId: string; threadCount: number; taskCount: number; decisionCount: number }[];
  /** Snoozed by the staleness sweep today. Undo = bringBackTask(taskId). */
  snoozedToday: TaskRef[];
  receipts: { executionId: string; title: string; client: string; status: string; summary: string | null; at: string }[];
  needsRetry: { meetingId: string; title: string; date: string; message: string | null }[];
  slackSyncedAt: number | null;
  /** "Jira today": null when nothing to show or Jira is not connected. */
  jira: WrapJira | null;
}

interface MomentBase {
  /** Dismissal key, e.g. `prep:<eventId>`, `wrap:<dateKey>`, `morning:<dateKey>`. */
  key: string;
  kind: OllieMomentKind;
  generatedAt: number;
}

export interface PrepMoment extends MomentBase { kind: 'prep'; prep: PrepContent }
export interface WrapMoment extends MomentBase { kind: 'wrap'; wrapUp: WrapUpContent }
export interface MorningMoment extends MomentBase { kind: 'morning'; morning: MorningContent }
export type OllieMoment = PrepMoment | WrapMoment | MorningMoment;

export interface CatchUpNote {
  personId: string;
  weeksSinceMet: number;
  waitingOn: string;
  /** Ready-to-render "N weeks since you met · waiting on <thing>". */
  text: string;
}

export interface OllieMomentChanged {
  reason: 'calendar' | 'prep-start' | 'meeting-start' | 'meeting-end' | 'wrap' | 'processed' | 'dismissed' | 'settings' | 'action' | 'day-change';
  /** Set when reason === 'processed'. */
  meetingId?: string;
}

export interface OllieFocusMoment {
  kind: OllieMomentKind | 'processed';
  key: string;
  meetingId?: string;
  eventId?: string;
}

export interface NotificationCopy {
  title: string;
  body: string;
}
