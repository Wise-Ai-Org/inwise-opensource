/**
 * The single path for every Jira write (docs/JIRA_SAFETY.md).
 *
 * submitJiraWrite: idempotency check -> gate (jira-gate.ts) -> either a
 * pending-approval entry in the queue, or a logged push. Meeting pushes,
 * pull-side link fixes, task-edit sync, the renderer's jira:* IPC, approvals
 * and retries all come through here, so every write carries provenance, a
 * numeric confidence and an audit-log entry.
 */
import { log } from './logger';
import { getJiraWritePrefs } from './config';
import { getTaskById, updateTask } from './database';
import {
  executeJiraPush, fetchIssueBrief, buildJiraIssueUrl, commentPrefix,
  type JiraIssueBrief,
} from './jira-client';
import {
  recordWrite, getWriteEntry, listByIdempotencyKey, listByTaskId, applyApprovalEdit,
  incrementRetry, markCompleted, computeCreateDiffs, computeUpdateDiffs, isUserRejected,
  USER_REJECTED,
  type FieldDiff, type PushParams, type SorWriteEntry, type TranscriptSpan,
} from './sor-write-log';
import { stashPending, getPending, removePending, listPending } from './sor-pending-approvals';
import { decideJiraWrite, taskReviewOf, type JiraInitiator, type JiraWriteMode } from './jira-gate';
import { statusLabel } from './jira-transitions';

export interface JiraWriteRequest {
  pushParams: PushParams;
  initiator: JiraInitiator;
  /** 0..1 from computeWriteConfidence. User clicks pass 1. */
  confidence: number;
  sourceMeetingId?: string | null;
  meetingTitle?: string | null;
  linkedTaskId?: string | null;
  idempotencyKey?: string | null;
  transcriptSpan?: TranscriptSpan;
  /** Hold for a person even under the auto setting. */
  forceReview?: boolean;
  suggestion?: string | null;
  issueTitle?: string | null;
  evidence?: string | null;
  intent?: string | null;
}

export type JiraWriteOutcome =
  | { status: 'pushed'; id: string; key?: string; url?: string | null }
  | { status: 'failed'; id: string; error: string }
  | { status: 'held'; id: string; reason: string }
  | { status: 'duplicate'; existingId: string | null; key: string | null; reason: string }
  | { status: 'waiting'; reason: string }
  | { status: 'dropped'; reason: string };

interface Deps {
  execute: typeof executeJiraPush;
  fetchBrief: (key: string) => Promise<JiraIssueBrief | null>;
  getTask: (id: string | null | undefined) => Promise<any | null>;
  updateTask: (id: string, updates: Record<string, any>) => Promise<any>;
  prefs: () => { mode: JiraWriteMode; threshold: number };
  issueUrl: (key: string) => string | null;
}

const realDeps: Deps = {
  execute: executeJiraPush,
  fetchBrief: fetchIssueBrief,
  getTask: getTaskById,
  updateTask,
  prefs: getJiraWritePrefs,
  issueUrl: buildJiraIssueUrl,
};
let deps: Deps = realDeps;

/** Test-only: swap the network, task store and settings. */
export function __setJiraWriteDepsForTests(overrides: Partial<Deps> | null): void {
  deps = overrides ? { ...realDeps, ...overrides } : realDeps;
}

/** Jira key a local task is linked to, if any. */
export function linkedIssueKey(task: any): string | null {
  if (!task) return null;
  if (task.source?.type === 'jira' && typeof task.source.id === 'string' && task.source.id) return task.source.id;
  if (typeof task.jiraKey === 'string' && task.jiraKey) return task.jiraKey;
  return null;
}

/** Normalized action-item text: the per-meeting idempotency key component. */
export function normalizeItemText(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export function meetingItemKey(meetingId: string, text: string): string {
  return `meeting:${meetingId}:${normalizeItemText(text)}`;
}

/** Link a local task to an issue. Never overwrites a link to a different key. */
export async function linkTaskToIssue(taskId: string | null | undefined, key: string, url?: string | null): Promise<boolean> {
  if (!taskId) {
    log('warn', 'jira:link-missing-task', `no local task to link ${key}`);
    return false;
  }
  const task = await deps.getTask(taskId);
  if (!task) return false;
  const existing = linkedIssueKey(task);
  if (existing && existing !== key) {
    log('warn', 'jira:link-conflict', `task ${taskId} is linked to ${existing}; not relinking to ${key}`);
    return false;
  }
  if (existing === key) return true;
  await deps.updateTask(taskId, {
    source: { type: 'jira', id: key, url: url ?? deps.issueUrl(key) ?? undefined },
    jiraKey: key,
    updatedAt: new Date().toISOString(),
  });
  return true;
}

function clamp01(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

async function diffsFor(p: PushParams): Promise<{ fieldDiffs: FieldDiff[]; commentBody: string | null; targetRecordId: string; issueTitle: string | null }> {
  if (p.operation === 'create') {
    return { fieldDiffs: computeCreateDiffs({ ...p.args }), commentBody: null, targetRecordId: '(pending-create)', issueTitle: null };
  }
  if (p.operation === 'comment') {
    return { fieldDiffs: [], commentBody: commentPrefix(p.args.meetingTitle) + p.args.comment, targetRecordId: p.args.issueKey, issueTitle: null };
  }
  const brief = await deps.fetchBrief(p.args.issueKey).catch(() => null);
  if (p.operation === 'transition') {
    return {
      fieldDiffs: [{ field: 'status', before: brief?.status ?? null, after: statusLabel(p.args.targetStatus) }],
      commentBody: null,
      targetRecordId: p.args.issueKey,
      issueTitle: brief?.title || null,
    };
  }
  const before = brief
    ? { title: brief.title, description: brief.description, priority: brief.priority, dueDate: brief.dueDate }
    : {};
  const fieldDiffs = brief
    ? computeUpdateDiffs(before, { ...p.args.updates })
    : Object.entries(p.args.updates).filter(([, v]) => v !== undefined).map(([field, after]) => ({ field, before: null, after }));
  return { fieldDiffs, commentBody: null, targetRecordId: p.args.issueKey, issueTitle: brief?.title || null };
}

/** Is there already a write for this item / task that a new create would duplicate? */
async function findDuplicate(req: JiraWriteRequest, task: any | null): Promise<JiraWriteOutcome | null> {
  if (req.idempotencyKey) {
    const prior = await listByIdempotencyKey(req.idempotencyKey);
    if (prior.length > 0) {
      const p = prior[0];
      return {
        status: 'duplicate',
        existingId: p._id,
        key: p.targetRecordId && p.targetRecordId !== '(pending-create)' ? p.targetRecordId : null,
        reason: isUserRejected(p) ? 'you skipped this before' : `already ${p.result}`,
      };
    }
  }
  if (req.pushParams.operation === 'create') {
    const key = linkedIssueKey(task);
    if (key) return { status: 'duplicate', existingId: null, key, reason: `task is already linked to ${key}` };
    if (req.linkedTaskId) {
      const creates = (await listByTaskId(req.linkedTaskId)).filter((e) => e.operation === 'create');
      if (creates.length > 0) {
        const c = creates[0];
        return {
          status: 'duplicate',
          existingId: c._id,
          key: c.targetRecordId !== '(pending-create)' ? c.targetRecordId : null,
          reason: c.result === 'failed' && !isUserRejected(c) ? 'an earlier create failed; retry it instead' : `create already ${c.result}`,
        };
      }
    }
  }
  return null;
}

// Writes run one at a time so two passes can never both pass the idempotency
// check before either records its entry.
let writeChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.catch(() => undefined).then(fn);
  writeChain = run.catch(() => undefined);
  return run;
}

export function submitJiraWrite(req: JiraWriteRequest): Promise<JiraWriteOutcome> {
  return serialized(() => submitOnce(req));
}

async function submitOnce(req: JiraWriteRequest): Promise<JiraWriteOutcome> {
  const task = req.linkedTaskId ? await deps.getTask(req.linkedTaskId) : null;
  const dup = await findDuplicate(req, task);
  if (dup) return dup;

  const prefs = deps.prefs();
  const confidence = req.initiator === 'user' ? 1 : clamp01(req.confidence);
  const decision = decideJiraWrite({
    mode: prefs.mode,
    threshold: prefs.threshold,
    confidence,
    initiator: req.initiator,
    taskReview: req.linkedTaskId ? taskReviewOf(task) : 'none',
    dedupPending: !!task?.dedupSuggestion,
    forceReview: req.forceReview,
  });
  if (decision.action === 'wait') return { status: 'waiting', reason: decision.reason };
  if (decision.action === 'drop') return { status: 'dropped', reason: decision.reason };

  const { fieldDiffs, commentBody, targetRecordId, issueTitle } = await diffsFor(req.pushParams);
  const held = decision.action === 'hold';
  const id = await recordWrite({
    targetSystem: 'jira',
    targetRecordId,
    targetRecordUrl: targetRecordId === '(pending-create)' ? null : deps.issueUrl(targetRecordId),
    operation: req.pushParams.operation,
    fieldDiffs,
    commentBody,
    pushParams: req.pushParams,
    result: held ? 'pending-approval' : 'pending',
    provenance: {
      sourceMeetingId: req.sourceMeetingId || undefined,
      sourceTranscriptSpan: req.transcriptSpan,
      linkedTaskId: req.linkedTaskId || undefined,
      confidence: req.initiator === 'user' ? clamp01(req.confidence ?? 1) : confidence,
      approvalPath: req.initiator === 'user' ? 'user' : held ? 'opt-in-gated' : 'auto',
      idempotencyKey: req.idempotencyKey || undefined,
      initiator: req.initiator,
      gateReason: decision.reason,
      suggestion: req.suggestion ?? null,
      issueTitle: req.issueTitle ?? issueTitle,
      evidence: req.evidence ?? null,
      intent: req.intent ?? null,
    },
  });

  if (held) {
    await stashPending({
      _id: id,
      targetSystem: 'jira',
      pushParams: req.pushParams,
      meetingTitle: req.meetingTitle ?? null,
      linkedTaskId: req.linkedTaskId ?? null,
      createdAt: new Date().toISOString(),
    });
    return { status: 'held', id, reason: decision.reason };
  }
  return push(id, req.pushParams, req.linkedTaskId ?? null);
}

async function push(id: string, pushParams: PushParams, linkedTaskId: string | null): Promise<JiraWriteOutcome> {
  const res = await deps.execute(id, pushParams);
  if (!res.ok) return { status: 'failed', id, error: res.error || 'Jira write failed' };
  if (pushParams.operation === 'create' && res.key) await linkTaskToIssue(linkedTaskId, res.key, res.url);
  return { status: 'pushed', id, key: res.key, url: res.url };
}

// ── Approval queue ─────────────────────────────────────────────────────────

export interface ApprovalOverrides {
  title?: string;
  description?: string;
  priority?: string;
  dueDate?: string;
  comment?: string;
  updates?: { title?: string; description?: string; priority?: string; dueDate?: string };
}

/** The user approved a held write (Review page, recap row, prep row). */
export function approveHeldWrite(id: string, overrides?: ApprovalOverrides): Promise<{ ok: boolean; error?: string; key?: string }> {
  return serialized(() => approveOnce(id, overrides));
}

async function approveOnce(id: string, overrides?: ApprovalOverrides): Promise<{ ok: boolean; error?: string; key?: string }> {
  const pending = await getPending(id);
  if (!pending) return { ok: false, error: 'No pending approval for that id' };
  const entry = await getWriteEntry(id);
  if (!entry) return { ok: false, error: 'Audit entry missing' };

  let pushParams = pending.pushParams;
  let fieldDiffs: FieldDiff[] | undefined;
  let commentBody: string | null | undefined;
  if (overrides) {
    if (pushParams.operation === 'create') {
      const merged = {
        ...pushParams.args,
        ...(overrides.title !== undefined ? { title: overrides.title } : {}),
        ...(overrides.description !== undefined ? { description: overrides.description } : {}),
        ...(overrides.priority !== undefined ? { priority: overrides.priority } : {}),
        ...(overrides.dueDate !== undefined ? { dueDate: overrides.dueDate } : {}),
      };
      pushParams = { operation: 'create', args: merged };
      fieldDiffs = computeCreateDiffs(merged);
    } else if (pushParams.operation === 'comment' && overrides.comment !== undefined) {
      pushParams = { operation: 'comment', args: { ...pushParams.args, comment: overrides.comment } };
      commentBody = commentPrefix(pending.meetingTitle) + overrides.comment;
    } else if (pushParams.operation === 'update' && overrides.updates) {
      pushParams = { operation: 'update', args: { ...pushParams.args, updates: { ...pushParams.args.updates, ...overrides.updates } } };
    }
  }

  const task = pending.linkedTaskId ? await deps.getTask(pending.linkedTaskId) : null;
  if (pushParams.operation === 'create') {
    const key = linkedIssueKey(task);
    if (key) {
      await markCompleted(id, 'failed', `Already linked to ${key}`);
      await removePending(id);
      return { ok: false, error: `This task is already linked to ${key}` };
    }
  }
  // Approving the Jira change also keeps the local task it belongs to.
  if (task && taskReviewOf(task) === 'pending') {
    await deps.updateTask(task._id, { approval: { ...(task.approval || {}), status: 'approved', reviewedAt: new Date().toISOString() } });
  }

  await applyApprovalEdit(id, { fieldDiffs, commentBody, pushParams, approvalPath: 'user', result: 'pending' });
  await removePending(id);
  const out = await push(id, pushParams, pending.linkedTaskId);
  if (out.status === 'pushed') return { ok: true, key: out.key };
  return { ok: false, error: out.status === 'failed' ? out.error : 'Jira write failed' };
}

export async function rejectHeldWrite(id: string): Promise<{ ok: boolean; error?: string }> {
  const pending = await getPending(id);
  if (!pending) return { ok: false, error: 'No pending approval for that id' };
  await markCompleted(id, 'failed', USER_REJECTED);
  await removePending(id);
  return { ok: true };
}

/** Retry a failed write (a click). Never re-creates an issue the task already has. */
export function retryJiraWrite(id: string): Promise<{ ok: boolean; error?: string }> {
  return serialized(() => retryOnce(id));
}

async function retryOnce(id: string): Promise<{ ok: boolean; error?: string }> {
  const entry = await getWriteEntry(id);
  if (!entry) return { ok: false, error: 'Entry not found' };
  if (entry.targetSystem !== 'jira') return { ok: false, error: `Cannot retry ${entry.targetSystem} writes` };
  if (!entry.pushParams) return { ok: false, error: 'No stored push params' };
  if (entry.result === 'success') return { ok: true };
  if (entry.result === 'pending-approval') return { ok: false, error: 'This change is waiting for your OK' };
  if (isUserRejected(entry)) return { ok: false, error: 'You skipped this change' };
  if (entry.pushParams.operation === 'create') {
    const key = linkedIssueKey(await deps.getTask(entry.linkedTaskId));
    if (key) return { ok: false, error: `This task is already linked to ${key}` };
  }
  await incrementRetry(id);
  await applyApprovalEdit(id, { approvalPath: 'user' });
  const out = await push(id, entry.pushParams, entry.linkedTaskId);
  return out.status === 'pushed' ? { ok: true } : { ok: false, error: out.status === 'failed' ? out.error : 'Retry failed' };
}

/**
 * The local task was kept or skipped. Skipped: its held Jira writes are
 * skipped too. Kept under the auto setting: held writes that were only waiting
 * on confidence go through (suggestions still need their own OK). Under "Ask
 * me every time" keeping a task never pushes; the Jira row has its own Approve.
 */
export async function onTaskReviewed(taskId: string, status: 'approved' | 'rejected'): Promise<number> {
  if (!taskId) return 0;
  const held = (await listPending()).filter((p) => p.linkedTaskId === taskId);
  let n = 0;
  for (const p of held) {
    if (status === 'rejected') {
      await rejectHeldWrite(p._id);
      n++;
      continue;
    }
    if (deps.prefs().mode !== 'auto') continue;
    const entry = await getWriteEntry(p._id);
    if (!entry || entry.suggestion) continue;
    const res = await approveHeldWrite(p._id);
    if (res.ok) n++;
  }
  return n;
}

export type { SorWriteEntry };
