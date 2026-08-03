/**
 * Durable local audit trail for action-item execution through MCP clients.
 *
 * Inwise never performs the external work here. Claude, Codex, OpenWorker, or
 * another MCP host owns those tool calls. This log records the user-approved
 * plan, the results the host reports back, and any resulting Inwise task-status
 * change so the meeting memory and the work stay connected.
 */

import * as path from 'path';
import { app } from 'electron';
import { randomUUID as uuidv4 } from 'crypto';
import Datastore from '@seald-io/nedb';

export type ActionExecutionStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type ActionOutcomeResult = 'progress' | 'completed' | 'failed';

export interface ProposedExecutionTool {
  name: string;
  purpose: string;
  target: string | null;
  dataShared: string | null;
}

export interface ExecutionApproval {
  approvedBy: string;
  approvedAt: string;
  scope: string;
  approvedTools: string[];
}

export interface ExecutionArtifact {
  type: string;
  label: string;
  url: string;
  externalId: string | null;
}

export interface ActionExecutionOutcome {
  id: string;
  idempotencyKey: string;
  result: ActionOutcomeResult;
  summary: string;
  artifacts: ExecutionArtifact[];
  remainingWork: string | null;
  client: string;
  createdAt: string;
}

export interface ActionExecutionAuditEvent {
  id: string;
  type: 'execution-started' | 'outcome-appended' | 'action-status-updated';
  at: string;
  client: string;
  idempotencyKey: string;
  details: Record<string, any>;
}

export interface ActionExecutionEntry {
  _id: string;
  actionItemId: string;
  actionItemTitle: string;
  objective: string;
  plan: string[];
  proposedTools: ProposedExecutionTool[];
  client: string;
  approval: ExecutionApproval;
  status: ActionExecutionStatus;
  outcomes: ActionExecutionOutcome[];
  startIdempotencyKey: string;
  requestFingerprint: string;
  auditTrail: ActionExecutionAuditEvent[];
  createdAt: string;
  updatedAt: string;
}

let actionExecutionsDb: Datastore<ActionExecutionEntry> | null = null;

export function initActionExecutionLog(): void {
  const userDataPath = app.getPath('userData');
  actionExecutionsDb = new Datastore<ActionExecutionEntry>({
    filename: path.join(userDataPath, 'action-executions.db'),
    autoload: true,
  });
  // Application-level checks below provide the replay behavior. The unique
  // index also closes the small race between two simultaneous first calls.
  void actionExecutionsDb.ensureIndexAsync({ fieldName: 'startIdempotencyKey', unique: true });
}

/** Test-only injection, matching the database.ts and sor-write-log.ts pattern. */
export function __setActionExecutionsDbForTests(db: Datastore<any>): void {
  actionExecutionsDb = db as Datastore<ActionExecutionEntry>;
}

function getDb(): Datastore<ActionExecutionEntry> {
  if (!actionExecutionsDb) {
    throw new Error('action-execution-log not initialised — call initActionExecutionLog() first');
  }
  return actionExecutionsDb;
}

export interface StartExecutionInput {
  actionItemId: string;
  actionItemTitle: string;
  objective: string;
  plan: string[];
  proposedTools: ProposedExecutionTool[];
  client: string;
  approval: ExecutionApproval;
  idempotencyKey: string;
}

export async function createActionExecution(
  input: StartExecutionInput,
): Promise<{ execution: ActionExecutionEntry; replayed: boolean }> {
  const db = getDb();
  const requestFingerprint = JSON.stringify({
    actionItemId: input.actionItemId,
    actionItemTitle: input.actionItemTitle,
    objective: input.objective,
    plan: input.plan,
    proposedTools: input.proposedTools,
    client: input.client,
    approval: input.approval,
  });
  const existing = (await db.findOneAsync({
    startIdempotencyKey: input.idempotencyKey,
  })) as ActionExecutionEntry | null;
  if (existing) {
    if (
      existing.requestFingerprint !== requestFingerprint
    ) {
      throw new Error('idempotencyKey was already used for a different execution request');
    }
    return { execution: existing, replayed: true };
  }

  const now = new Date().toISOString();
  const execution: ActionExecutionEntry = {
    _id: uuidv4(),
    actionItemId: input.actionItemId,
    actionItemTitle: input.actionItemTitle,
    objective: input.objective,
    plan: input.plan,
    proposedTools: input.proposedTools,
    client: input.client,
    approval: input.approval,
    status: 'running',
    outcomes: [],
    startIdempotencyKey: input.idempotencyKey,
    requestFingerprint,
    auditTrail: [
      {
        id: uuidv4(),
        type: 'execution-started',
        at: now,
        client: input.client,
        idempotencyKey: input.idempotencyKey,
        details: {
          objective: input.objective,
          plan: input.plan,
          proposedTools: input.proposedTools,
          approval: input.approval,
        },
      },
    ],
    createdAt: now,
    updatedAt: now,
  };

  try {
    await db.insertAsync(execution);
    return { execution, replayed: false };
  } catch (err: any) {
    // If two identical retries raced, return the winner. Conflicting requests
    // still fail through the comparison above/below.
    const winner = (await db.findOneAsync({
      startIdempotencyKey: input.idempotencyKey,
    })) as ActionExecutionEntry | null;
    if (
      winner &&
      winner.requestFingerprint === requestFingerprint
    ) {
      return { execution: winner, replayed: true };
    }
    throw err;
  }
}

export interface AppendOutcomeInput {
  idempotencyKey: string;
  result: ActionOutcomeResult;
  summary: string;
  artifacts: ExecutionArtifact[];
  remainingWork: string | null;
  client: string;
}

export async function appendExecutionOutcome(
  executionId: string,
  input: AppendOutcomeInput,
): Promise<{ execution: ActionExecutionEntry; outcome: ActionExecutionOutcome; replayed: boolean }> {
  const db = getDb();
  const existing = (await db.findOneAsync({ _id: executionId })) as ActionExecutionEntry | null;
  if (!existing) throw new Error(`No action execution found with id "${executionId}"`);
  if (existing.client !== input.client) {
    throw new Error(`Execution belongs to client "${existing.client}"; received "${input.client}"`);
  }

  const replay = existing.outcomes.find((o) => o.idempotencyKey === input.idempotencyKey);
  if (replay) {
    if (
      replay.summary !== input.summary ||
      replay.result !== input.result ||
      replay.remainingWork !== input.remainingWork ||
      JSON.stringify(replay.artifacts) !== JSON.stringify(input.artifacts)
    ) {
      throw new Error('idempotencyKey was already used for a different outcome');
    }
    return { execution: existing, outcome: replay, replayed: true };
  }
  if (existing.status === 'cancelled') throw new Error('Cannot append an outcome to a cancelled execution');

  const now = new Date().toISOString();
  const outcome: ActionExecutionOutcome = {
    id: uuidv4(),
    idempotencyKey: input.idempotencyKey,
    result: input.result,
    summary: input.summary,
    artifacts: input.artifacts,
    remainingWork: input.remainingWork,
    client: input.client,
    createdAt: now,
  };
  const status: ActionExecutionStatus =
    input.result === 'completed' ? 'completed' : input.result === 'failed' ? 'failed' : 'running';
  const event: ActionExecutionAuditEvent = {
    id: uuidv4(),
    type: 'outcome-appended',
    at: now,
    client: input.client,
    idempotencyKey: input.idempotencyKey,
    details: { outcomeId: outcome.id, result: outcome.result, summary: outcome.summary },
  };
  await db.updateAsync(
    { _id: executionId },
    {
      $push: { outcomes: outcome, auditTrail: event },
      $set: { status, updatedAt: now },
    } as any,
    {},
  );
  const updated = (await db.findOneAsync({ _id: executionId })) as ActionExecutionEntry;
  return { execution: updated, outcome, replayed: false };
}

export async function recordActionStatusUpdate(
  executionId: string,
  input: {
    actionItemId: string;
    fromStatus: string;
    toStatus: string;
    note: string | null;
    client: string;
    idempotencyKey: string;
  },
): Promise<{ execution: ActionExecutionEntry; replayed: boolean }> {
  const db = getDb();
  const existing = (await db.findOneAsync({ _id: executionId })) as ActionExecutionEntry | null;
  if (!existing) throw new Error(`No action execution found with id "${executionId}"`);
  if (existing.actionItemId !== input.actionItemId) {
    throw new Error('executionId is not linked to this action item');
  }
  if (existing.client !== input.client) {
    throw new Error(`Execution belongs to client "${existing.client}"; received "${input.client}"`);
  }
  const replay = existing.auditTrail.find(
    (e) => e.type === 'action-status-updated' && e.idempotencyKey === input.idempotencyKey,
  );
  if (replay) {
    if (replay.details.toStatus !== input.toStatus || replay.details.note !== input.note) {
      throw new Error('idempotencyKey was already used for a different status update');
    }
    return { execution: existing, replayed: true };
  }

  const now = new Date().toISOString();
  const event: ActionExecutionAuditEvent = {
    id: uuidv4(),
    type: 'action-status-updated',
    at: now,
    client: input.client,
    idempotencyKey: input.idempotencyKey,
    details: {
      actionItemId: input.actionItemId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      note: input.note,
    },
  };
  const terminalStatus: ActionExecutionStatus | null =
    ['completed', 'done'].includes(input.toStatus)
      ? 'completed'
      : input.toStatus === 'cancelled'
        ? 'cancelled'
        : null;
  const set: Record<string, any> = { updatedAt: now };
  if (terminalStatus) set.status = terminalStatus;
  await db.updateAsync(
    { _id: executionId },
    { $push: { auditTrail: event }, $set: set } as any,
    {},
  );
  const updated = (await db.findOneAsync({ _id: executionId })) as ActionExecutionEntry;
  return { execution: updated, replayed: false };
}

export async function getActionExecution(id: string): Promise<ActionExecutionEntry | null> {
  return (await getDb().findOneAsync({ _id: id })) as ActionExecutionEntry | null;
}

export async function listActionExecutionsByActionItem(actionItemId: string): Promise<ActionExecutionEntry[]> {
  const rows = await (getDb() as any)
    .findAsync({ actionItemId })
    .sort({ createdAt: -1 });
  return rows as ActionExecutionEntry[];
}
