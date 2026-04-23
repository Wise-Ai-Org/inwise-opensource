/**
 * System-of-Record write audit log.
 *
 * Durable record of every write Inwise makes to an external system-of-record
 * (today: Jira; schema-extensible to Salesforce / HubSpot / Linear).
 *
 * Pure DB helpers + pure field-diff computation. The push-side instrumentation
 * lives in `jira-client.ts` (which calls `recordWrite` → network → `markCompleted`)
 * so this file stays free of HTTP and is unit-testable with an in-memory NeDB.
 */

import * as path from 'path';
import { app } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import Datastore from '@seald-io/nedb';

export type TargetSystem = 'jira'; // future: 'salesforce' | 'hubspot' | 'linear'
export type SorOperation = 'create' | 'update' | 'transition' | 'comment';
export type ApprovalPath = 'auto' | 'user' | 'opt-in-gated';
export type SorWriteResult = 'pending' | 'success' | 'failed' | 'pending-approval' | 'retrying';

export interface FieldDiff {
  field: string;
  before: any;
  after: any;
}

export interface TranscriptSpan {
  start: number;
  end: number;
  snippet: string;
}

export interface WriteProvenance {
  sourceMeetingId?: string;
  sourceTranscriptSpan?: TranscriptSpan;
  linkedTaskId?: string;
  confidence?: number;
  approvalPath?: ApprovalPath;
}

/**
 * Stored push parameters — enough to re-run the original write on retry.
 * Shape is operation-specific; callers of `retryJiraWrite` destructure based on `operation`.
 */
export type PushParams =
  | { operation: 'create'; args: { title: string; description?: string; priority?: string; dueDate?: string; projectKey: string } }
  | { operation: 'update'; args: { issueKey: string; updates: { title?: string; description?: string; priority?: string; dueDate?: string } } }
  | { operation: 'transition'; args: { issueKey: string; targetStatus: string } }
  | { operation: 'comment'; args: { issueKey: string; comment: string; meetingTitle?: string } };

export interface SorWriteEntry {
  _id: string;
  targetSystem: TargetSystem;
  targetRecordId: string;        // e.g. "PROJ-123"; for pending 'create' before Jira assigns a key, a placeholder like "(pending-create)"
  targetRecordUrl: string | null;
  operation: SorOperation;
  fieldDiffs: FieldDiff[];       // empty for 'comment'
  commentBody: string | null;    // populated for 'comment' only
  sourceMeetingId: string | null;
  sourceTranscriptSpan: TranscriptSpan | null;
  linkedTaskId: string | null;
  confidence: number | null;     // 0..1
  approvalPath: ApprovalPath;
  result: SorWriteResult;
  errorMessage: string | null;
  pushParams: PushParams | null; // stored for retry
  createdAt: string;             // ISO
  completedAt: string | null;    // ISO, set when result transitions to success|failed
  retryCount: number;
}

let sorWritesDb: Datastore<SorWriteEntry> | null = null;

type CompletedListener = (entry: SorWriteEntry) => void;
let completedListener: CompletedListener | null = null;

export function initSorWriteLog(): void {
  const userDataPath = app.getPath('userData');
  sorWritesDb = new Datastore<SorWriteEntry>({
    filename: path.join(userDataPath, 'sor-writes.db'),
    autoload: true,
  });
}

/**
 * Register a listener invoked after every `markCompleted`. main.ts wires this
 * to `mainWindow.webContents.send('sor:write-completed', entry)` so renderers
 * can live-refresh. One listener only — this is an internal coupling, not a pub/sub.
 */
export function onWriteCompleted(listener: CompletedListener | null): void {
  completedListener = listener;
}

/**
 * Test-only: inject an in-memory NeDB so unit tests can exercise this module
 * without Electron. Mirrors the `__setTasksDbForTests` pattern in `database.ts`.
 */
export function __setSorWritesDbForTests(db: Datastore<any>): void {
  sorWritesDb = db as Datastore<SorWriteEntry>;
}

function getDb(): Datastore<SorWriteEntry> {
  if (!sorWritesDb) throw new Error('sor-write-log not initialised — call initSorWriteLog() first');
  return sorWritesDb;
}

// ── Record / complete / retry ────────────────────────────────────────────────

export interface RecordWriteInput {
  targetSystem: TargetSystem;
  targetRecordId: string;
  targetRecordUrl?: string | null;
  operation: SorOperation;
  fieldDiffs?: FieldDiff[];
  commentBody?: string | null;
  provenance?: WriteProvenance;
  pushParams?: PushParams | null;
  result?: SorWriteResult; // default 'pending'
}

export async function recordWrite(input: RecordWriteInput): Promise<string> {
  const db = getDb();
  const id = uuidv4();
  const entry: SorWriteEntry = {
    _id: id,
    targetSystem: input.targetSystem,
    targetRecordId: input.targetRecordId,
    targetRecordUrl: input.targetRecordUrl ?? null,
    operation: input.operation,
    fieldDiffs: input.fieldDiffs ?? [],
    commentBody: input.commentBody ?? null,
    sourceMeetingId: input.provenance?.sourceMeetingId ?? null,
    sourceTranscriptSpan: input.provenance?.sourceTranscriptSpan ?? null,
    linkedTaskId: input.provenance?.linkedTaskId ?? null,
    confidence: input.provenance?.confidence ?? null,
    approvalPath: input.provenance?.approvalPath ?? 'auto',
    result: input.result ?? 'pending',
    errorMessage: null,
    pushParams: input.pushParams ?? null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    retryCount: 0,
  };
  await db.insertAsync(entry);
  return id;
}

export async function markCompleted(
  id: string,
  result: 'success' | 'failed',
  errorMessage?: string,
  updates?: { targetRecordId?: string; targetRecordUrl?: string | null },
): Promise<void> {
  const db = getDb();
  const set: Record<string, any> = {
    result,
    errorMessage: errorMessage ?? null,
    completedAt: new Date().toISOString(),
  };
  if (updates?.targetRecordId !== undefined) set.targetRecordId = updates.targetRecordId;
  if (updates?.targetRecordUrl !== undefined) set.targetRecordUrl = updates.targetRecordUrl;
  await db.updateAsync({ _id: id }, { $set: set }, {});
  if (completedListener) {
    const fresh = (await db.findOneAsync({ _id: id })) as SorWriteEntry | null;
    if (fresh) {
      try { completedListener(fresh); } catch { /* swallow — live-refresh is best-effort */ }
    }
  }
}

export async function incrementRetry(id: string): Promise<void> {
  const db = getDb();
  await db.updateAsync(
    { _id: id },
    { $inc: { retryCount: 1 }, $set: { result: 'retrying', errorMessage: null } },
    {},
  );
}

export async function getWriteEntry(id: string): Promise<SorWriteEntry | null> {
  const db = getDb();
  return (await db.findOneAsync({ _id: id })) as SorWriteEntry | null;
}

// ── Queries ──────────────────────────────────────────────────────────────────

export async function listRecent(limit = 50, sinceMs?: number): Promise<SorWriteEntry[]> {
  const db = getDb();
  const query: any = {};
  if (sinceMs !== undefined) query.createdAt = { $gte: new Date(sinceMs).toISOString() };
  const rows = await (db as any).findAsync(query).sort({ createdAt: -1 }).limit(limit);
  return rows as SorWriteEntry[];
}

export async function listByMeeting(meetingId: string): Promise<SorWriteEntry[]> {
  const db = getDb();
  const rows = await (db as any).findAsync({ sourceMeetingId: meetingId }).sort({ createdAt: -1 });
  return rows as SorWriteEntry[];
}

export async function listByTaskId(taskId: string): Promise<SorWriteEntry[]> {
  const db = getDb();
  const rows = await (db as any).findAsync({ linkedTaskId: taskId }).sort({ createdAt: -1 });
  return rows as SorWriteEntry[];
}

export async function listByTargetRecord(system: TargetSystem, recordId: string): Promise<SorWriteEntry[]> {
  const db = getDb();
  const rows = await (db as any)
    .findAsync({ targetSystem: system, targetRecordId: recordId })
    .sort({ createdAt: -1 });
  return rows as SorWriteEntry[];
}

export interface IntegrationAggregate {
  system: TargetSystem;
  total: number;
  success: number;
  failed: number;
  lastWriteAt: string | null;
}

export async function aggregateByIntegration(sinceMs?: number): Promise<IntegrationAggregate[]> {
  const db = getDb();
  const query: any = {};
  if (sinceMs !== undefined) query.createdAt = { $gte: new Date(sinceMs).toISOString() };
  const rows = (await db.findAsync(query)) as SorWriteEntry[];

  const bySystem = new Map<TargetSystem, IntegrationAggregate>();
  for (const r of rows) {
    let agg = bySystem.get(r.targetSystem);
    if (!agg) {
      agg = { system: r.targetSystem, total: 0, success: 0, failed: 0, lastWriteAt: null };
      bySystem.set(r.targetSystem, agg);
    }
    agg.total += 1;
    if (r.result === 'success') agg.success += 1;
    else if (r.result === 'failed') agg.failed += 1;
    if (!agg.lastWriteAt || r.createdAt > agg.lastWriteAt) agg.lastWriteAt = r.createdAt;
  }
  return Array.from(bySystem.values());
}

/**
 * Entries stuck in 'pending', 'pending-approval', or 'retrying' older than `olderThanMs`.
 * Used at app-startup to detect interrupted writes after a crash / force-quit.
 */
export async function listStuckEntries(olderThanMs: number, now: Date = new Date()): Promise<SorWriteEntry[]> {
  const db = getDb();
  const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
  const rows = await db.findAsync({
    result: { $in: ['pending', 'pending-approval', 'retrying'] },
    createdAt: { $lt: cutoff },
  });
  return rows as SorWriteEntry[];
}

// ── Pure field-diff helpers ──────────────────────────────────────────────────

/**
 * Compute diffs for an 'update' operation: one entry per field present in `updates`
 * whose new value differs from the current value. Skips unchanged fields.
 *
 * Pure function — safe to unit-test without DB or HTTP.
 */
export function computeUpdateDiffs(
  before: Record<string, any>,
  updates: Record<string, any>,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const [field, after] of Object.entries(updates)) {
    if (after === undefined) continue;
    const b = before[field];
    if (!shallowEqual(b, after)) {
      diffs.push({ field, before: b ?? null, after });
    }
  }
  return diffs;
}

/**
 * Compute fieldDiffs for a 'create' — every provided field with before:null.
 */
export function computeCreateDiffs(fields: Record<string, any>): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const [field, after] of Object.entries(fields)) {
    if (after === undefined || after === null) continue;
    diffs.push({ field, before: null, after });
  }
  return diffs;
}

function shallowEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == b; // null == undefined intentionally
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}
