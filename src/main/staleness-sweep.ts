import { getTasks, snoozeTask, isSnoozed } from './database';
import { log } from './logger';

export interface SweepResult {
  snoozed: any[];
  eligible: number;
  totalActive: number;
  ranAt: string;
}

let lastSweepResult: SweepResult | null = null;

export function getLastSweepResult(): SweepResult | null {
  return lastSweepResult;
}

// Test-only hook to reset cached result between tests.
export function __resetLastSweepResultForTests(): void {
  lastSweepResult = null;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

function isStaleEligible(t: any, nowMs: number): boolean {
  if (!t) return false;
  if (t.status !== 'todo') return false;
  if (isSnoozed(t)) return false;
  if (t.priority === 'high' || t.priority === 'critical') return false;

  const updatedAt = t.updatedAt || t.createdAt;
  if (!updatedAt) return false;
  const updatedMs = new Date(updatedAt).getTime();
  if (!Number.isFinite(updatedMs)) return false;
  if (updatedMs >= nowMs - THIRTY_DAYS_MS) return false;

  if (t.lastMentionedAt) {
    const mentionedMs = new Date(t.lastMentionedAt).getTime();
    if (Number.isFinite(mentionedMs) && mentionedMs >= nowMs - FOURTEEN_DAYS_MS) {
      return false;
    }
  }

  return true;
}

export async function sweepStaleTasks(now: Date = new Date()): Promise<{ snoozed: any[] }> {
  const nowMs = now.getTime();
  const activeTasks = (await getTasks()).filter((t: any) => t.status === 'todo');
  const eligible = activeTasks.filter((t: any) => isStaleEligible(t, nowMs));

  const snoozed: any[] = [];
  for (const t of eligible) {
    await snoozeTask(t._id, 'stale-30d');
    snoozed.push({ ...t, snoozedAt: new Date(nowMs).toISOString(), snoozedReason: 'stale-30d' });
  }

  lastSweepResult = {
    snoozed,
    eligible: eligible.length,
    totalActive: activeTasks.length,
    ranAt: new Date(nowMs).toISOString(),
  };

  log(
    'info',
    'staleness-sweep',
    `snoozed=${snoozed.length} eligible=${eligible.length} of total active tasks=${activeTasks.length}`,
  );

  return { snoozed };
}
