/**
 * Signal-based task priority scoring engine.
 * Pure deterministic — no LLM calls. Scores each task 0–100 from weighted signals.
 *
 * Signals:
 *   Deadline proximity    (30 pts) — overdue = max, due today = high, this week = medium
 *   Meeting recency       (20 pts) — task from today's meeting > last month's
 *   Person engagement     (15 pts) — task tied to a high-engagement person
 *   Blocker association   (15 pts) — source meeting had blockers?
 *   Commitment linkage    (20 pts) — task backs a commitment someone made?
 */

interface ScoredTask {
  _id: string;
  score: number;
  signals: {
    deadline: number;
    meetingRecency: number;
    personEngagement: number;
    blockerAssociation: number;
    commitmentLinkage: number;
  };
  reasoning: string;
}

const WEIGHTS = {
  deadline: 30,
  meetingRecency: 20,
  personEngagement: 15,
  blockerAssociation: 15,
  commitmentLinkage: 20,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function scoreTasks(
  tasks: any[],
  meetings: any[],
  peopleStats: any[],
): ScoredTask[] {
  const now = Date.now();
  const meetingMap = new Map<string, any>();
  for (const m of meetings) meetingMap.set(m._id, m);

  // Build engagement lookup: name → score
  const engagementByName = new Map<string, number>();
  for (const p of peopleStats) {
    if (p.name) engagementByName.set(p.name.toLowerCase(), p.engagementScore || 0);
  }

  return tasks.map(task => {
    const signals = {
      deadline: scoreDeadline(task, now),
      meetingRecency: scoreMeetingRecency(task, meetingMap, now),
      personEngagement: scorePersonEngagement(task, meetingMap, engagementByName),
      blockerAssociation: scoreBlockerAssociation(task, meetingMap),
      commitmentLinkage: scoreCommitmentLinkage(task, meetingMap),
    };

    const score = Math.round(
      signals.deadline * WEIGHTS.deadline / 100 +
      signals.meetingRecency * WEIGHTS.meetingRecency / 100 +
      signals.personEngagement * WEIGHTS.personEngagement / 100 +
      signals.blockerAssociation * WEIGHTS.blockerAssociation / 100 +
      signals.commitmentLinkage * WEIGHTS.commitmentLinkage / 100
    );

    const reasoning = buildReasoning(signals, task);

    return { _id: task._id, score, signals, reasoning };
  }).sort((a, b) => b.score - a.score);
}

// ── Individual signal scorers (each returns 0–100) ───────────────────────────

function scoreDeadline(task: any, now: number): number {
  if (!task.dueDate) return 30; // neutral — not urgent but not deprioritized

  const due = new Date(task.dueDate).getTime();
  const daysUntil = (due - now) / DAY_MS;

  if (daysUntil < 0) return 100;            // overdue
  if (daysUntil < 1) return 90;             // due today
  if (daysUntil < 3) return 70;             // due in 1-3 days
  if (daysUntil < 7) return 50;             // due this week
  if (daysUntil < 14) return 30;            // due in 1-2 weeks
  return 15;                                 // due later
}

function scoreMeetingRecency(task: any, meetingMap: Map<string, any>, now: number): number {
  const meetingId = task.source?.id || task.provenance?.meetingId;
  if (!meetingId) return 20; // manual task — neutral

  const meeting = meetingMap.get(meetingId);
  if (!meeting?.date) return 20;

  const meetingTime = new Date(meeting.date).getTime();
  const daysAgo = (now - meetingTime) / DAY_MS;

  if (daysAgo < 1) return 100;              // today's meeting
  if (daysAgo < 3) return 80;               // last couple days
  if (daysAgo < 7) return 60;               // this week
  if (daysAgo < 14) return 40;              // last 2 weeks
  if (daysAgo < 30) return 20;              // last month
  return 10;                                 // older
}

function scorePersonEngagement(
  task: any,
  meetingMap: Map<string, any>,
  engagementByName: Map<string, number>,
): number {
  const meetingId = task.source?.id || task.provenance?.meetingId;
  if (!meetingId) return 30; // no meeting link — neutral

  const meeting = meetingMap.get(meetingId);
  if (!meeting?.attendees?.length) return 30;

  // Find the highest engagement score among attendees
  let maxEngagement = 0;
  for (const attendee of meeting.attendees) {
    const score = engagementByName.get(attendee.toLowerCase()) || 0;
    if (score > maxEngagement) maxEngagement = score;
  }

  return maxEngagement; // already 0-100
}

function scoreBlockerAssociation(task: any, meetingMap: Map<string, any>): number {
  const meetingId = task.source?.id || task.provenance?.meetingId;
  if (!meetingId) return 0;

  const meeting = meetingMap.get(meetingId);
  if (!meeting?.insights?.blockers?.length) return 0;

  // More blockers = higher urgency for tasks from that meeting
  const blockerCount = meeting.insights.blockers.length;
  if (blockerCount >= 3) return 100;
  if (blockerCount >= 2) return 75;
  return 50;
}

function scoreCommitmentLinkage(task: any, meetingMap: Map<string, any>): number {
  const meetingId = task.source?.id || task.provenance?.meetingId;
  if (!meetingId) return 0;

  const meeting = meetingMap.get(meetingId);
  if (!meeting?.insights?.commitments?.length) return 0;

  // Check if any commitment text roughly matches this task
  const taskTitle = task.title.toLowerCase();
  for (const commitment of meeting.insights.commitments) {
    const commitText = (commitment.text || '').toLowerCase();
    // Simple overlap check — shared significant words
    const taskWords = taskTitle.split(/\s+/).filter((w: string) => w.length > 3);
    const commitWords = commitText.split(/\s+/).filter((w: string) => w.length > 3);
    const overlap = taskWords.filter((w: string) => commitWords.includes(w)).length;
    if (overlap >= 2 || (overlap >= 1 && taskWords.length <= 3)) {
      // Task text overlaps with a commitment — strong linkage
      const hasDeadline = !!commitment.deadline;
      return hasDeadline ? 100 : 80;
    }
  }

  // Meeting had commitments but this task doesn't match any — slight boost
  return 20;
}

// ── Reasoning builder ────────────────────────────────────────────────────────

function buildReasoning(signals: ScoredTask['signals'], task: any): string {
  const parts: string[] = [];

  if (signals.deadline >= 90) {
    parts.push(task.dueDate ? `overdue or due today` : 'urgent deadline');
  } else if (signals.deadline >= 70) {
    parts.push('due soon');
  }

  if (signals.meetingRecency >= 80) parts.push('from a recent meeting');
  if (signals.personEngagement >= 70) parts.push('involves a key contact');
  if (signals.blockerAssociation >= 50) parts.push('related to active blockers');
  if (signals.commitmentLinkage >= 80) parts.push('backs a commitment');

  if (parts.length === 0) return 'Standard priority';
  return parts.join(', ').replace(/^./, c => c.toUpperCase());
}
