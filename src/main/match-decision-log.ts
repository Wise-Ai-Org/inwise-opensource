/**
 * Local match-decision log (US-011).
 *
 * Every dedup decision — auto-merge, confirm, reject, reopen, manual merge,
 * undo/split, below-ask create — is recorded in a NeDB file next to tasks.db.
 * The log NEVER leaves the machine; it exists so a user or contributor can
 * inspect matcher behavior (false-merge rate, confirm rate) and tune the
 * thresholds by hand. No automatic threshold adjustment in this build.
 */

import * as path from 'path';
import { app } from 'electron';
import { randomUUID as uuidv4 } from 'crypto';
import Datastore from '@seald-io/nedb';
import { log } from './logger';
import { MATCH_PROMPT_VERSION } from './dedup-constants';

export type MatchDecisionType =
  | 'auto_merge'
  | 'confirm_same'
  | 'confirm_new'
  | 'reopen_merge'
  | 'manual_merge'
  | 'undo_split'
  | 'below_ask_new';

export interface MatchDecisionEntry {
  _id?: string;
  decisionType: MatchDecisionType;
  confidence?: number | null;
  retrievalScore?: number | null;
  candidateTaskId?: string | null;
  taskId?: string | null;
  newItemText: string;
  decidedBy: 'system' | 'user';
  surface: 'oss';
  promptVersion?: string;
  createdAt?: string;
}

let decisionsDb: Datastore | null = null;
let lastDecisionSequence = 0;

function nextDecisionSequence(): number {
  const wallClockSequence = Date.now() * 1_000;
  lastDecisionSequence = Math.max(wallClockSequence, lastDecisionSequence + 1);
  return lastDecisionSequence;
}

export function initMatchDecisionLog(): void {
  const userDataPath = app.getPath('userData');
  decisionsDb = new Datastore({ filename: path.join(userDataPath, 'match-decisions.db'), autoload: true });
}

// Test-only: inject an in-memory Datastore. Do NOT call from production code.
export function __setMatchDecisionsDbForTests(db: Datastore): void {
  decisionsDb = db;
  lastDecisionSequence = 0;
}

/**
 * Append a decision. Logging failures are swallowed (logged) — recording a
 * decision must never break task creation or a merge.
 */
export async function logMatchDecision(entry: MatchDecisionEntry): Promise<void> {
  try {
    if (!decisionsDb) throw new Error('match-decision log not initialized');
    await decisionsDb.insertAsync({
      _id: uuidv4(),
      decisionType: entry.decisionType,
      confidence: entry.confidence ?? null,
      retrievalScore: entry.retrievalScore ?? null,
      candidateTaskId: entry.candidateTaskId ?? null,
      taskId: entry.taskId ?? null,
      newItemText: entry.newItemText,
      decidedBy: entry.decidedBy,
      surface: 'oss',
      promptVersion: entry.promptVersion ?? MATCH_PROMPT_VERSION,
      createdAt: entry.createdAt ?? new Date().toISOString(),
      sequence: nextDecisionSequence(),
    });
  } catch (e: any) {
    log('error', 'match-decision-log:write-failed', e?.message || String(e));
  }
}

export async function listMatchDecisions(limit = 200): Promise<any[]> {
  if (!decisionsDb) return [];
  const rows = await (decisionsDb as any).findAsync({}).sort({ createdAt: -1, sequence: -1 }).limit(limit);
  return rows;
}

export interface MatchDecisionStats {
  counts: Record<MatchDecisionType, number>;
  total: number;
  /** undone auto-merges ÷ auto-merges (false-merge rate) */
  falseMergeRate: number | null;
  /** confirm_same ÷ (confirm_same + confirm_new + reopen_merge) (confirm rate) */
  confirmRate: number | null;
}

export async function getMatchDecisionStats(): Promise<MatchDecisionStats> {
  const counts: Record<MatchDecisionType, number> = {
    auto_merge: 0,
    confirm_same: 0,
    confirm_new: 0,
    reopen_merge: 0,
    manual_merge: 0,
    undo_split: 0,
    below_ask_new: 0,
  };
  if (decisionsDb) {
    const rows: any[] = await decisionsDb.findAsync({});
    for (const r of rows) {
      if (r.decisionType in counts) counts[r.decisionType as MatchDecisionType]++;
    }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const falseMergeRate = counts.auto_merge > 0 ? counts.undo_split / counts.auto_merge : null;
  const promptsResolved = counts.confirm_same + counts.confirm_new + counts.reopen_merge;
  const confirmRate = promptsResolved > 0 ? counts.confirm_same / promptsResolved : null;
  return { counts, total, falseMergeRate, confirmRate };
}
