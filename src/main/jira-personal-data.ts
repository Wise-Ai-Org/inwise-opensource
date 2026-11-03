/**
 * Atlassian personal data reporting (docs/JIRA_SAFETY.md, "Personal data").
 *
 * Inwise keeps Jira people on this device for longer than 24 hours: the issue
 * cache (assignee, reporter, comment authors), the person -> Jira account links
 * on the People tab, and suggested assignments in the write log. Atlassian
 * requires apps that do this to report those accounts at least every 7 days and
 * act on the answer:
 *   - "closed": the person deleted their Atlassian account. Erase everything
 *     we hold about them.
 *   - "updated": their profile changed. Drop the cached copy so the next pull
 *     fetches it fresh.
 * POST https://api.atlassian.com/app/report-accounts/ takes up to 90 accounts
 * per call; 204 means nothing to do.
 */

export const REPORT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** Check daily so a week is never missed when the app sleeps through a timer. */
export const REPORT_CHECK_MS = 24 * 60 * 60 * 1000;
export const REPORT_BATCH = 90;
export const REPORT_URL = 'https://api.atlassian.com/app/report-accounts/';

export interface ReportedAccount { accountId: string; updatedAt: string }
export type AccountStatus = 'closed' | 'updated';
export interface AccountVerdict { accountId: string; status: AccountStatus }

/** Minimal shapes so this module stays testable without the stores. */
export interface IssueLike {
  key: string;
  pulledAt: string;
  assignee?: { accountId: string } | null;
  reporter?: { accountId: string } | null;
  comments?: { authorId: string | null }[];
}
export interface PersonLike { _id: string; jiraLink?: { accountId: string | null; checkedAt: string } | null }
export interface WriteLike { _id: string; createdAt?: string; timestamp?: string; pushParams?: any }

function later(a: string | undefined, b: string): string {
  return !a || b > a ? b : a;
}

export function issueAccountIds(issue: IssueLike): string[] {
  const ids = [issue.assignee?.accountId, issue.reporter?.accountId, ...(issue.comments || []).map(c => c.authorId)];
  return [...new Set(ids.filter((x): x is string => !!x))];
}

function writeAccountId(w: WriteLike): string | null {
  const p = w.pushParams;
  return p && p.operation === 'assign' && p.args?.accountId ? String(p.args.accountId) : null;
}

/** Every account we hold, with when we last fetched data about it. */
export function collectAccounts(input: {
  selfAccountId: string | null;
  issues: IssueLike[];
  people: PersonLike[];
  writes: WriteLike[];
  now: Date;
}): ReportedAccount[] {
  const seen = new Map<string, string>();
  const add = (id: string | null | undefined, at: string | undefined) => {
    if (!id) return;
    seen.set(id, later(seen.get(id), at || input.now.toISOString()));
  };
  add(input.selfAccountId, input.now.toISOString());
  for (const i of input.issues) for (const id of issueAccountIds(i)) add(id, i.pulledAt);
  for (const p of input.people) add(p.jiraLink?.accountId, p.jiraLink?.checkedAt);
  for (const w of input.writes) add(writeAccountId(w), w.createdAt || w.timestamp);
  return [...seen].map(([accountId, updatedAt]) => ({ accountId, updatedAt })).sort((a, b) => a.accountId.localeCompare(b.accountId));
}

export function batches<T>(items: T[], size = REPORT_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function isReportDue(lastReportAt: string | null | undefined, now: Date): boolean {
  if (!lastReportAt) return true;
  const t = Date.parse(lastReportAt);
  return !Number.isFinite(t) || now.getTime() - t >= REPORT_INTERVAL_MS;
}

export interface ReportDeps {
  isConnected: () => boolean;
  selfAccountId: () => string | null;
  listIssues: () => Promise<IssueLike[]>;
  listPeople: () => Promise<PersonLike[]>;
  listWrites: () => Promise<WriteLike[]>;
  /** One POST; null for 204. Throws { status, retryAfterSec? } on HTTP errors. */
  post: (accounts: ReportedAccount[]) => Promise<AccountVerdict[] | null>;
  removeIssues: (keys: string[]) => Promise<void>;
  clearPersonLink: (personId: string) => Promise<void>;
  redactWrite: (writeId: string) => Promise<void>;
  disconnect: () => void;
  getLastReportAt: () => string | null;
  setLastReportAt: (iso: string) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export interface ReportSummary {
  ran: boolean;
  reported: number;
  closed: number;
  updated: number;
  error?: string;
}

/** Erase or refresh what we hold for each verdict. */
export async function applyVerdicts(
  verdicts: AccountVerdict[],
  data: { selfAccountId: string | null; issues: IssueLike[]; people: PersonLike[]; writes: WriteLike[] },
  deps: Pick<ReportDeps, 'removeIssues' | 'clearPersonLink' | 'redactWrite' | 'disconnect'>,
): Promise<{ closed: number; updated: number }> {
  const closed = new Set(verdicts.filter(v => v.status === 'closed').map(v => v.accountId));
  const touched = new Set(verdicts.map(v => v.accountId));
  if (touched.size === 0) return { closed: 0, updated: 0 };

  // Cached issues mentioning anyone closed or updated: drop, the next pull refetches them.
  const keys = data.issues.filter(i => issueAccountIds(i).some(id => touched.has(id))).map(i => i.key);
  if (keys.length) await deps.removeIssues(keys);

  for (const p of data.people) {
    const id = p.jiraLink?.accountId;
    // Closed: forget the link. Updated: forget it too; the email lookup or
    // "Find in Jira" relinks with the current name.
    if (id && touched.has(id)) await deps.clearPersonLink(p._id);
  }
  for (const w of data.writes) {
    const id = writeAccountId(w);
    if (id && closed.has(id)) await deps.redactWrite(w._id);
  }
  if (data.selfAccountId && closed.has(data.selfAccountId)) deps.disconnect();
  return { closed: closed.size, updated: touched.size - closed.size };
}

export async function runPersonalDataReport(deps: ReportDeps, now: Date = new Date(), force = false): Promise<ReportSummary> {
  if (!deps.isConnected()) return { ran: false, reported: 0, closed: 0, updated: 0 };
  if (!force && !isReportDue(deps.getLastReportAt(), now)) return { ran: false, reported: 0, closed: 0, updated: 0 };

  const [issues, people, writes] = await Promise.all([deps.listIssues(), deps.listPeople(), deps.listWrites()]);
  const selfAccountId = deps.selfAccountId();
  const accounts = collectAccounts({ selfAccountId, issues, people, writes, now });
  const verdicts: AccountVerdict[] = [];
  try {
    for (const batch of batches(accounts)) {
      const res = await deps.post(batch);
      if (res) verdicts.push(...res.filter(v => v && v.accountId && (v.status === 'closed' || v.status === 'updated')));
    }
  } catch (e: any) {
    // Not marked as reported: the daily check tries again tomorrow.
    const msg = e?.status === 429 ? `rate limited${e.retryAfterSec ? `, retry after ${e.retryAfterSec}s` : ''}` : String(e?.message || e);
    deps.log('warn', `report failed: ${msg}`);
    return { ran: true, reported: 0, closed: 0, updated: 0, error: msg };
  }
  const { closed, updated } = await applyVerdicts(verdicts, { selfAccountId, issues, people, writes }, deps);
  deps.setLastReportAt(now.toISOString());
  deps.log('info', `reported ${accounts.length} account(s); closed ${closed}, updated ${updated}`);
  return { ran: true, reported: accounts.length, closed, updated };
}
