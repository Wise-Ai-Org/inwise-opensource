/**
 * SoR pending-approvals queue (US-006).
 *
 * Sibling of `sor-write-log.ts`. When the approval gate is on and a write's
 * confidence is below the user's threshold, the write is NOT pushed. Instead:
 *   1. A `sor-writes.db` entry is recorded with `result: 'pending-approval'`
 *      (so the receipt is queryable via the regular listRecent / listByMeeting
 *      surfaces).
 *   2. A row is inserted into this collection, keyed to the sor-writes id.
 *      The row stores the exact parameters and extra context needed to re-run
 *      the push later — without forcing a JOIN back to sor-writes when the UI
 *      is listing "what's waiting for me".
 *
 * Kept separate from sor-write-log.ts so the write-audit module stays
 * single-purpose (durable log of what has been attempted) and this module
 * carries the transient work-queue state.
 */

import * as path from 'path';
import { app } from 'electron';
import Datastore from '@seald-io/nedb';
import type { PushParams } from './sor-write-log';

export interface PendingApprovalPayload {
  /** Matches the `_id` of the corresponding `sor-writes.db` entry. */
  _id: string;
  /** Every gated integration uses its own push function — keep system here for dispatch. */
  targetSystem: 'jira';
  /** Enough to re-run the write via the appropriate client. */
  pushParams: PushParams;
  /** Meeting title — comment ops prepend it to the comment body, so the original must be preserved. */
  meetingTitle: string | null;
  /** Local task to patch with `source: { type, id, url }` once the write succeeds. */
  linkedTaskId: string | null;
  /** When this approval landed in the queue. Used by the UI to render "Pending N days". */
  createdAt: string;
}

let pendingDb: Datastore<PendingApprovalPayload> | null = null;

export function initPendingApprovals(): void {
  const userDataPath = app.getPath('userData');
  pendingDb = new Datastore<PendingApprovalPayload>({
    filename: path.join(userDataPath, 'sor-pending-approvals.db'),
    autoload: true,
  });
}

/**
 * Test-only injector. Mirrors `__setSorWritesDbForTests`.
 */
export function __setPendingApprovalsDbForTests(db: Datastore<any>): void {
  pendingDb = db as Datastore<PendingApprovalPayload>;
}

function getDb(): Datastore<PendingApprovalPayload> {
  if (!pendingDb) throw new Error('sor-pending-approvals not initialised — call initPendingApprovals() first');
  return pendingDb;
}

export async function stashPending(payload: PendingApprovalPayload): Promise<void> {
  await getDb().insertAsync(payload);
}

export async function getPending(id: string): Promise<PendingApprovalPayload | null> {
  return (await getDb().findOneAsync({ _id: id })) as PendingApprovalPayload | null;
}

export async function listPending(): Promise<PendingApprovalPayload[]> {
  const rows = await (getDb() as any).findAsync({}).sort({ createdAt: -1 });
  return rows as PendingApprovalPayload[];
}

export async function removePending(id: string): Promise<void> {
  await getDb().removeAsync({ _id: id }, {});
}
