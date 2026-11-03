/**
 * The one decision every Jira write goes through (docs/JIRA_SAFETY.md).
 * Pure: the caller supplies the setting, the confidence and the local task's
 * review state; this returns what to do. jira-writes.ts applies it.
 */

export type JiraWriteMode = 'ask' | 'auto';
export const JIRA_AUTO_THRESHOLD = 0.9;

/** Who started the write. A click in the UI counts as approval of that write. */
export type JiraInitiator = 'user' | 'system';

/** Review state of the local task the write belongs to. */
export type TaskReview = 'approved' | 'pending' | 'rejected' | 'none';

export interface GateInput {
  mode: JiraWriteMode;
  threshold?: number;
  confidence: number;
  initiator: JiraInitiator;
  taskReview: TaskReview;
  /** The local task is waiting on a "same task?" dedup answer. */
  dedupPending?: boolean;
  /** Always needs a person (for example "Update PILOT-42 instead?" suggestions). */
  forceReview?: boolean;
}

export type GateAction =
  /** Push now. */
  | 'push'
  /** Record as pending-approval and wait in the approval queue. */
  | 'hold'
  /** Record nothing yet; re-plan when the dedup question is answered. */
  | 'wait'
  /** Do not write: the user already said no to the local task. */
  | 'drop';

export interface GateDecision {
  action: GateAction;
  reason: string;
}

export function decideJiraWrite(input: GateInput): GateDecision {
  const threshold = typeof input.threshold === 'number' ? input.threshold : JIRA_AUTO_THRESHOLD;
  if (input.initiator === 'user') return { action: 'push', reason: 'approved by your click' };
  if (input.taskReview === 'rejected') return { action: 'drop', reason: 'task was skipped' };
  if (input.dedupPending) return { action: 'wait', reason: 'waiting on the duplicate question' };
  if (input.forceReview) return { action: 'hold', reason: 'possible existing ticket' };
  if (input.mode !== 'auto') return { action: 'hold', reason: 'ask me every time' };
  const confidence = Number.isFinite(input.confidence) ? input.confidence : 0;
  if (confidence >= threshold) return { action: 'push', reason: `very sure (${Math.round(confidence * 100)}%)` };
  if (input.taskReview === 'approved') return { action: 'push', reason: 'you kept the task' };
  return { action: 'hold', reason: `not sure enough (${Math.round(confidence * 100)}%)` };
}

/** Task approval field -> review state. Tasks without an approval block count as approved. */
export function taskReviewOf(task: any | null | undefined): TaskReview {
  if (!task) return 'none';
  const status = task.approval?.status;
  if (status === 'pending') return 'pending';
  if (status === 'rejected') return 'rejected';
  return 'approved';
}

/**
 * Settings migration. `sor.jira.writeMode` is new. Before it existed the only
 * knobs were approvalGateEnabled (default false) and approvalThreshold
 * (default 0.6), and electron-store persists defaults, so an untouched
 * install is indistinguishable from someone who chose those exact values.
 * Treat anything that differs from the shipped defaults as an explicit choice:
 *  - gate turned on       -> 'auto' (they wanted confident writes to go through)
 *  - threshold changed    -> 'auto'
 *  - otherwise            -> 'ask'
 */
export function resolveJiraWriteMode(stored: { writeMode?: unknown; approvalGateEnabled?: unknown; approvalThreshold?: unknown } | null | undefined): JiraWriteMode {
  if (stored?.writeMode === 'ask' || stored?.writeMode === 'auto') return stored.writeMode;
  const gateOn = stored?.approvalGateEnabled === true;
  const thresholdChanged = typeof stored?.approvalThreshold === 'number' && stored.approvalThreshold !== 0.6;
  return gateOn || thresholdChanged ? 'auto' : 'ask';
}
