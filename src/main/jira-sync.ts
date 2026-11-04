/**
 * Meeting -> Jira proposals and Jira -> local pull (docs/JIRA_SAFETY.md).
 *
 * Meeting pass: runs after insights are saved on any processing path. For
 * each action item it works from the local task the item landed in (local
 * dedup already ran) and proposes exactly one Jira write per item:
 *   - task already linked to a key (dedup merged into it) -> comment there
 *   - a key was said -> comment there
 *   - strong keyword match (>= 0.85) -> comment there
 *   - middle band (0.3-0.85) -> ask the LLM; a likely existing ticket becomes
 *     "Update PILOT-42 instead?" for a person to decide, never a silent create
 *   - otherwise -> create in the default project
 * Ticket intents (done / due moved / decision) become transition / due-date
 * update / comment proposals on the ticket they name. Every proposal goes
 * through submitJiraWrite (gate + idempotency).
 */
import { log } from './logger';
import { getConfig, setConfig } from './config';
import {
  getMeeting, getTaskById, getPeople, getTasks, upsertPulledJiraTask, hasTaskLinkedToJiraKey, setPersonJiraLink,
  type SaveInsightsResult,
} from './database';
import {
  getJiraStories, searchJiraIssuesPage, findJiraAccountIdByEmail, findSprintFieldId,
  getJiraAccountId, isJiraConnected, findSprintForIssue, type JiraStory, type SprintLookup,
} from './jira-client';
import { resolvePerson } from './ollie-content';
import { matchItemToStories, semanticMatch } from './jira-matcher';
import { computeWriteConfidence, spokenIssueKeys } from './jira-confidence';
import {
  submitJiraWrite, onTaskReviewed, linkedIssueKey, meetingItemKey, normalizeItemText,
  type JiraWriteOutcome, type JiraWriteRequest,
} from './jira-writes';
import {
  buildPullJql, computePullWindowDays, fetchAllPages, mapIssueSnapshot, pullFields,
  saveIssueSnapshots, listCachedIssues, pruneIssueCache, localTaskFieldsFor, adfToText,
  PULL_MAX_ATTENDEES, type JiraIssueSnapshot,
} from './jira-pull';
import type { PushParams } from './sor-write-log';
import { resolvePersonAccountId, type JiraLink } from './jira-people';

export const STRONG_MATCH = 0.85;
export const MIDDLE_BAND_LOW = 0.3;
// Keyword-only similarity tops out at 0.5 (no key mention), so 0.3 is a solid hint match.
const INTENT_MATCH_MIN = 0.3;
const SKIP_SOURCES = new Set(['demo_seed', 'slack_thread', 'voice_memo']);

export interface StoryLike {
  jiraKey: string; title: string; description: string; jiraUrl: string;
  statusCategory?: string | null; assigneeId?: string | null; sprintName?: string | null;
  /** Open issues blocking this one, from the pull cache. */
  blockedByKeys?: string[];
}

interface SyncDeps {
  getMeeting: (id: string) => Promise<any>;
  getTask: (id: string | null | undefined) => Promise<any | null>;
  loadStories: (projectKey: string | undefined) => Promise<StoryLike[]>;
  semantic: (items: { text: string }[], stories: { jiraKey: string; title: string }[]) => Promise<Record<string, string | null>>;
  submit: (req: JiraWriteRequest) => Promise<JiraWriteOutcome>;
  settings: () => { autoPush: boolean; connected: boolean; projectKey: string | null };
  /** Local tasks linked to Jira, as match candidates for "a linked task". */
  linkedTasks: () => Promise<StoryLike[]>;
  /** Person record for a spoken name, or null. */
  findPerson: (name: string) => Promise<any | null>;
  lookupEmail: (email: string) => Promise<string | null>;
  saveLink: (personId: string, link: JiraLink) => Promise<void>;
  findSprint: (issueKey: string, prefer: 'active' | 'next') => Promise<SprintLookup>;
  /** The connected Jira user, or null. */
  self: () => { accountId: string; displayName: string } | null;
}

async function realLoadStories(projectKey: string | undefined): Promise<StoryLike[]> {
  const byKey = new Map<string, StoryLike>();
  for (const s of await listCachedIssues().catch(() => [] as JiraIssueSnapshot[])) {
    byKey.set(s.key, {
      jiraKey: s.key, title: s.title, description: '', jiraUrl: s.url || '', statusCategory: s.statusCategory,
      assigneeId: s.assignee?.accountId || null, sprintName: s.sprint?.state === 'active' ? s.sprint.name : null,
      blockedByKeys: (s.blockedBy || []).map((b) => b.key),
    });
  }
  try {
    for (const s of await getJiraStories(projectKey) as JiraStory[]) {
      if (!byKey.has(s.jiraKey)) byKey.set(s.jiraKey, { jiraKey: s.jiraKey, title: s.title, description: s.description, jiraUrl: s.jiraUrl });
    }
  } catch (e: any) {
    log('warn', 'jira:stories-unavailable', e.message);
  }
  return Array.from(byKey.values());
}

const realDeps: SyncDeps = {
  getMeeting,
  getTask: getTaskById,
  loadStories: realLoadStories,
  semantic: semanticMatch,
  submit: submitJiraWrite,
  linkedTasks: async () => (await getTasks().catch(() => [] as any[]))
    .map((t: any) => ({ t, key: linkedIssueKey(t) }))
    .filter((x: any) => !!x.key)
    .map(({ t, key }: any) => ({ jiraKey: key, title: t.title || '', description: '', jiraUrl: t.source?.url || '' })),
  findPerson: async (name: string) => resolvePerson(name, await getPeople().catch(() => [] as any[])),
  lookupEmail: findJiraAccountIdByEmail,
  saveLink: async (personId, link) => { await setPersonJiraLink(personId, link); },
  findSprint: findSprintForIssue,
  self: () => {
    const t: any = (getConfig() as any).jiraTokens;
    return t?.accountId ? { accountId: t.accountId, displayName: t.displayName || '' } : null;
  },
  settings: () => {
    const cfg: any = getConfig();
    return { autoPush: cfg.jiraAutoPush === true, connected: isJiraConnected(), projectKey: cfg.jiraDefaultProject || null };
  },
};
let deps: SyncDeps = realDeps;

export function __setJiraSyncDepsForTests(overrides: Partial<SyncDeps> | null): void {
  deps = overrides ? { ...realDeps, ...overrides } : realDeps;
}

export interface MeetingSyncSummary {
  pushed: number;
  held: number;
  waiting: number;
  duplicate: number;
  dropped: number;
  failed: number;
}

function tally(summary: MeetingSyncSummary, out: JiraWriteOutcome): void {
  if (out.status === 'pushed') summary.pushed++;
  else if (out.status === 'held') summary.held++;
  else if (out.status === 'waiting') summary.waiting++;
  else if (out.status === 'duplicate') summary.duplicate++;
  else if (out.status === 'dropped') summary.dropped++;
  else summary.failed++;
}

const actionBody = (item: any) => `Action item: ${item.text}\nOwner: ${item.owner || 'Unassigned'}${item.dueDate ? `\nDue: ${item.dueDate}` : ''}`;

/**
 * Propose Jira writes for one meeting. Safe to call any number of times:
 * idempotency keys make a repeat a no-op. `onlyTaskId` re-plans a single item
 * (after its dedup question is answered).
 */
const meetingSyncs = new Map<string, Promise<MeetingSyncSummary>>();

export function syncMeetingToJira(meetingId: string, opts: { onlyTaskId?: string } = {}): Promise<MeetingSyncSummary> {
  // One pass per meeting at a time; a second call queues behind the first.
  const prev = meetingSyncs.get(meetingId) || Promise.resolve(null as any);
  const next = prev.catch(() => null).then(() => syncMeetingOnce(meetingId, opts));
  meetingSyncs.set(meetingId, next);
  void next.finally(() => { if (meetingSyncs.get(meetingId) === next) meetingSyncs.delete(meetingId); }).catch(() => {});
  return next;
}

/** Resolves once any running Jira pass for this meeting has finished. */
export async function waitForMeetingSync(meetingId: string): Promise<void> {
  const running = meetingSyncs.get(meetingId);
  if (running) await running.catch(() => null);
}

async function syncMeetingOnce(meetingId: string, opts: { onlyTaskId?: string }): Promise<MeetingSyncSummary> {
  const summary: MeetingSyncSummary = { pushed: 0, held: 0, waiting: 0, duplicate: 0, dropped: 0, failed: 0 };
  const settings = deps.settings();
  if (!settings.connected || !settings.autoPush) return summary;
  const meeting = await deps.getMeeting(meetingId);
  if (!meeting || SKIP_SOURCES.has(meeting.source)) return summary;
  const meetingTitle = meeting.title || 'Meeting';
  const items: any[] = Array.isArray(meeting.insights?.actionItems) ? meeting.insights.actionItems : [];
  const intents: any[] = opts.onlyTaskId ? [] : (Array.isArray(meeting.insights?.ticketIntents) ? meeting.insights.ticketIntents : []);
  if (items.length === 0 && intents.length === 0) return summary;

  const stories = await deps.loadStories(settings.projectKey || undefined);
  const storyByKey = new Map(stories.map((s) => [s.jiraKey, s]));

  // Pass 1: resolve each item's target without network writes.
  type Plan = { item: any; task: any; key: string | null; match: number; keySpoken: boolean; suggestion: boolean; best: StoryLike | null };
  const plans: Plan[] = [];
  for (const item of items) {
    if (!item?.text) continue;
    if (opts.onlyTaskId && item.taskId !== opts.onlyTaskId) continue;
    const task = item.taskId ? await deps.getTask(item.taskId) : null;
    if (!task) continue; // the local task is gone (skipped and deleted); nothing to sync
    const linked = linkedIssueKey(task);
    const spoken = item.issueKey ? [item.issueKey] : spokenIssueKeys(`${item.text} ${item.evidence || ''}`);
    if (linked) { plans.push({ item, task, key: linked, match: 1, keySpoken: spoken.includes(linked), suggestion: false, best: storyByKey.get(linked) || null }); continue; }
    if (spoken.length > 0) { plans.push({ item, task, key: spoken[0], match: 1, keySpoken: true, suggestion: false, best: storyByKey.get(spoken[0]) || null }); continue; }
    const best = matchItemToStories(item.text, stories)[0] || null;
    const sim = best?.similarity ?? 0;
    if (best && sim >= STRONG_MATCH) { plans.push({ item, task, key: best.jiraKey, match: sim, keySpoken: false, suggestion: false, best: storyByKey.get(best.jiraKey) || null }); continue; }
    plans.push({ item, task, key: null, match: sim, keySpoken: false, suggestion: !!best && sim >= MIDDLE_BAND_LOW, best: best ? storyByKey.get(best.jiraKey) || null : null });
  }

  // Middle band: one LLM call for all of them. A confirmed or unanswered
  // match stays a suggestion; an explicit "no match" becomes a create.
  const middle = plans.filter((p) => p.suggestion && p.best);
  if (middle.length > 0) {
    let llm: Record<string, string | null> = {};
    let llmAnswered = false;
    try {
      llm = await deps.semantic(middle.map((p) => ({ text: p.item.text })), stories.map((s) => ({ jiraKey: s.jiraKey, title: s.title })));
      llmAnswered = Object.keys(llm).length > 0;
    } catch { llmAnswered = false; }
    middle.forEach((p, i) => {
      const answer = llm[String(i + 1)];
      if (llmAnswered && answer === null) { p.suggestion = false; return; }
      if (llmAnswered && answer && storyByKey.has(answer)) p.best = storyByKey.get(answer)!;
    });
  }

  // An action item that only restates a ticket intent ("move I90-364 to In
  // Progress", "pull I90-363 into this sprint") gets the intent's own row,
  // not a second comment saying the same thing.
  const intentEvidence = intents
    .filter((t) => t && t.kind !== 'new' && t.kind !== 'decision')
    .map((t) => ({ keys: new Set([t.issueKey, t.blockerKey, ...spokenIssueKeys(`${t.text || ''} ${t.evidence || ''}`)].filter(Boolean)), sentences: evidenceSentences(t.evidence || '') }))
    .filter((t) => t.sentences.length > 0);
  // Restates = shares a quoted sentence that names this ticket.
  const restatesIntent = (key: string, item: any) => {
    const mine = evidenceSentences(item.evidence || '').filter((x) => x.includes(key.toLowerCase().replace(/[^a-z0-9]+/g, ' ')));
    return mine.length > 0 && intentEvidence.some((t) => t.keys.has(key) && t.sentences.some((x) => mine.includes(x)));
  };

  for (const p of plans) {
    const item = p.item;
    if (p.key && !opts.onlyTaskId && restatesIntent(p.key, item)) continue;
    const base = {
      initiator: 'system' as const,
      sourceMeetingId: meetingId,
      meetingTitle,
      linkedTaskId: p.task._id,
      idempotencyKey: meetingItemKey(meetingId, item.text),
      transcriptSpan: { start: 0, end: (item.evidence || item.text).length, snippet: item.evidence || item.text },
      evidence: item.evidence || null,
    };
    const signals = {
      extractionCertainty: item.certainty ?? item.confidence,
      ownerIdentified: !!item.owner,
      dueDateExplicit: item.dueDateExplicit === true,
    };
    if (p.key) {
      const pushParams: PushParams = { operation: 'comment', args: { issueKey: p.key, comment: actionBody(item), meetingTitle } };
      const { confidence } = computeWriteConfidence({ operation: 'comment', ...signals, keySpoken: p.keySpoken, matchStrength: p.match });
      tally(summary, await deps.submit({ ...base, pushParams, confidence, issueTitle: p.best?.title || null }));
      continue;
    }
    if (p.suggestion && p.best) {
      const pushParams: PushParams = { operation: 'comment', args: { issueKey: p.best.jiraKey, comment: actionBody(item), meetingTitle } };
      const { confidence } = computeWriteConfidence({ operation: 'comment', ...signals, matchStrength: p.match });
      tally(summary, await deps.submit({
        ...base, pushParams, confidence, forceReview: true,
        suggestion: `Update ${p.best.jiraKey} instead?`, issueTitle: p.best.title,
      }));
      continue;
    }
    if (!settings.projectKey) continue; // nowhere to create
    const pushParams: PushParams = {
      operation: 'create',
      args: {
        title: item.text,
        description: `From meeting: ${meetingTitle}\nOwner: ${item.owner || 'Unassigned'}`,
        priority: item.priority || 'medium',
        dueDate: item.dueDate || undefined,
        projectKey: settings.projectKey,
      },
    };
    const { confidence } = computeWriteConfidence({ operation: 'create', ...signals, matchStrength: p.match });
    tally(summary, await deps.submit({ ...base, pushParams, confidence, intent: 'new' }));
  }

  for (const intent of intents) {
    const out = await proposeIntent(meetingId, meetingTitle, intent, stories, storyByKey);
    if (out) tally(summary, out);
  }

  if (summary.pushed + summary.held + summary.failed > 0) {
    log('info', 'jira:meeting-sync', `${meetingId}: pushed ${summary.pushed}, held ${summary.held}, waiting ${summary.waiting}, skipped ${summary.duplicate} already handled, failed ${summary.failed}`);
  }
  return summary;
}

/**
 * Strict identification for link suggestions: a spoken key, a Jira-linked
 * local task or ticket whose title matches at the strong band, or an LLM
 * match. Anything weaker returns null and the suggestion is skipped.
 */
async function identifyStrict(spokenKey: string | null, hint: string, stories: StoryLike[], linked: StoryLike[]): Promise<{ key: string; strength: number; spoken: boolean } | null> {
  if (spokenKey) return { key: spokenKey, strength: 1, spoken: true };
  const text = (hint || '').trim();
  if (!text) return null;
  const pool = [...linked, ...stories.filter((s) => !linked.some((l) => l.jiraKey === s.jiraKey))];
  const best = matchItemToStories(text, pool)[0];
  if (best && best.matchFactors.title >= STRONG_MATCH) return { key: best.jiraKey, strength: best.matchFactors.title, spoken: false };
  try {
    const llm = await deps.semantic([{ text }], pool.map((s) => ({ jiraKey: s.jiraKey, title: s.title })));
    const key = llm['1'];
    if (key && pool.some((s) => s.jiraKey === key)) return { key, strength: STRONG_MATCH, spoken: false };
  } catch { /* no LLM: not identified */ }
  return null;
}

const normEvidence = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** Quote split into normalized sentences of 3+ words. */
const evidenceSentences = (v: string) => v.split(/(?<=[.!?])\s+/).map(normEvidence).filter((x) => x.split(' ').length >= 3);
const normName = (v: string) => v.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** "me" / "myself" / the connected user's full Jira name. */
export function isSelfName(name: string, selfDisplayName: string | null | undefined): boolean {
  const n = normName(name || '');
  if (!n) return false;
  if (n === 'me' || n === 'myself' || n === 'i') return true;
  return !!selfDisplayName && n === normName(selfDisplayName);
}

/** Jira accountId for a spoken name: the connected user, stored id, then email; never a guess. */
async function accountForName(name: string): Promise<{ accountId: string | null; personId: string | null; displayName: string }> {
  // The connected Jira user: "me", "myself", or their own Jira name.
  const self = deps.self();
  if (self && isSelfName(name, self.displayName)) return { accountId: self.accountId, personId: null, displayName: self.displayName || name };
  const person = await deps.findPerson(name).catch(() => null);
  if (!person) return { accountId: null, personId: null, displayName: name };
  const res = await resolvePersonAccountId(person, (email) => deps.lookupEmail(email));
  if (res.update) await deps.saveLink(person._id, res.update).catch(() => undefined);
  return { accountId: res.accountId, personId: person._id, displayName: person.name || name };
}

async function proposeIntent(
  meetingId: string,
  meetingTitle: string,
  intent: any,
  stories: StoryLike[],
  storyByKey: Map<string, StoryLike>,
): Promise<JiraWriteOutcome | null> {
  if (!intent || intent.kind === 'new') return null; // new work is proposed from the action items
  const spokenKey: string | null = intent.issueKey || spokenIssueKeys(`${intent.text || ''} ${intent.evidence || ''}`)[0] || null;
  let key: string | null = spokenKey;
  let match = key ? 1 : 0;
  let keySpoken = !!key;
  if (intent.kind === 'blocked_by') {
    // Both ends must be identified strictly; otherwise no suggestion at all.
    const linked = await deps.linkedTasks().catch(() => [] as StoryLike[]);
    const blocked = await identifyStrict(spokenKey, intent.ticketHint || '', stories, linked);
    if (!blocked) return null;
    const blockerSpoken = intent.blockerKey || null;
    const blocker = await identifyStrict(blockerSpoken, intent.blockerHint || '', stories.filter((s) => s.jiraKey !== blocked.key), linked.filter((s) => s.jiraKey !== blocked.key));
    if (!blocker || blocker.key === blocked.key) return null;
    if (storyByKey.get(blocked.key)?.blockedByKeys?.includes(blocker.key)) return null; // Jira already has this link
    const { confidence } = computeWriteConfidence({
      operation: 'link', extractionCertainty: intent.certainty,
      keySpoken: blocked.spoken && blocker.spoken, matchStrength: Math.min(blocked.strength, blocker.strength),
    });
    return deps.submit({
      initiator: 'system', sourceMeetingId: meetingId, meetingTitle,
      idempotencyKey: `meeting:${meetingId}:intent:blocked_by:${blocked.key}:${blocker.key}`,
      transcriptSpan: intent.evidence ? { start: 0, end: intent.evidence.length, snippet: intent.evidence } : undefined,
      evidence: intent.evidence || null, issueTitle: storyByKey.get(blocked.key)?.title || null, intent: intent.kind,
      pushParams: { operation: 'link', args: { blockedKey: blocked.key, blockerKey: blocker.key } },
      confidence,
    });
  }
  if (!key) {
    const best = matchItemToStories((intent.ticketHint || intent.text || '').trim(), stories)[0];
    if (!best || best.similarity < INTENT_MATCH_MIN) return null; // no ticket we can name with confidence: no row
    key = best.jiraKey;
    match = best.similarity;
    keySpoken = false;
  }
  const story = storyByKey.get(key) || null;
  const base = {
    initiator: 'system' as const,
    sourceMeetingId: meetingId,
    meetingTitle,
    idempotencyKey: `meeting:${meetingId}:intent:${intent.kind}:${key}`,
    transcriptSpan: intent.evidence ? { start: 0, end: intent.evidence.length, snippet: intent.evidence } : undefined,
    evidence: intent.evidence || null,
    issueTitle: story?.title || null,
    intent: intent.kind,
  };
  const signals = { extractionCertainty: intent.certainty, keySpoken, matchStrength: match };
  if (intent.kind === 'done') {
    if (story?.statusCategory === 'done') return null;
    const { confidence } = computeWriteConfidence({ operation: 'transition', ...signals });
    return deps.submit({ ...base, pushParams: { operation: 'transition', args: { issueKey: key, targetStatus: 'done' } }, confidence });
  }
  if (intent.kind === 'started') {
    if (story?.statusCategory === 'indeterminate' || story?.statusCategory === 'done') return null;
    const { confidence } = computeWriteConfidence({ operation: 'transition', ...signals });
    return deps.submit({ ...base, pushParams: { operation: 'transition', args: { issueKey: key, targetStatus: 'in_progress' } }, confidence });
  }
  if (intent.kind === 'due_moved' && intent.dueDate) {
    const { confidence } = computeWriteConfidence({ operation: 'update', ...signals, dueDateExplicit: true });
    return deps.submit({ ...base, pushParams: { operation: 'update', args: { issueKey: key, updates: { dueDate: intent.dueDate } } }, confidence });
  }
  if (intent.kind === 'decision' && intent.text) {
    const { confidence } = computeWriteConfidence({ operation: 'comment', ...signals });
    return deps.submit({ ...base, pushParams: { operation: 'comment', args: { issueKey: key, comment: `Decision: ${intent.text}`, meetingTitle } }, confidence });
  }
  if (intent.kind === 'reassign' && intent.assigneeName) {
    const who = await accountForName(intent.assigneeName);
    if (who.accountId && story?.assigneeId === who.accountId) return null; // already theirs
    const { confidence } = computeWriteConfidence({ operation: 'assign', ...signals, ownerIdentified: !!who.accountId });
    return deps.submit({
      ...base,
      pushParams: { operation: 'assign', args: { issueKey: key, accountId: who.accountId, assigneeName: who.displayName, personId: who.personId } },
      confidence,
    });
  }
  if (intent.kind === 'sprint') {
    const prefer = intent.sprint === 'next' ? 'next' : 'active';
    const found = await deps.findSprint(key, prefer).catch((e: any) => ({ ok: false as const, reason: `Could not read sprints (${e?.message || 'Jira error'})` }));
    if (found.ok && story?.sprintName && story.sprintName === found.sprintName) return null; // already in it
    const { confidence } = computeWriteConfidence({ operation: 'sprint', ...signals });
    return deps.submit({
      ...base,
      pushParams: found.ok
        ? { operation: 'sprint', args: { issueKey: key, sprintId: found.sprintId, sprintName: found.sprintName } }
        : { operation: 'sprint', args: { issueKey: key, sprintId: null, sprintName: null, reason: found.reason } },
      confidence,
    });
  }
  return null;
}

/** Wired to database.onInsightsSaved: drop held writes of removed tasks, then propose. */
export async function afterInsightsSaved(meetingId: string, result: SaveInsightsResult): Promise<MeetingSyncSummary | null> {
  try {
    for (const id of result.removedTaskIds) await onTaskReviewed(id, 'rejected');
    return await syncMeetingToJira(meetingId);
  } catch (e: any) {
    log('error', 'jira:meeting-sync-failed', e?.message || String(e));
    return null;
  }
}

/** A dedup question was answered: re-plan just that item (it may now target a linked ticket). */
export async function replanTaskAfterDedup(meetingId: string | null | undefined, taskId: string | null | undefined): Promise<void> {
  if (!meetingId || !taskId) return;
  try { await syncMeetingToJira(meetingId, { onlyTaskId: taskId }); }
  catch (e: any) { log('error', 'jira:replan-failed', e?.message || String(e)); }
}

/** Unique-ish key for a task edit sync so a double click never writes twice. */
export function taskEditKey(taskId: string, field: string, value: unknown): string {
  return `task:${taskId}:${field}:${normalizeItemText(String(value ?? ''))}`;
}

// ── Pull ──────────────────────────────────────────────────────────────────

interface PullDeps {
  connected: () => boolean;
  lastSuccessMs: () => number | null;
  markSuccess: (ms: number) => void;
  defaultProject: () => string | null;
  cloudUrl: () => string | null;
  myAccountId: () => string | null;
  /** People met in the last 30 days (bounded), not including you. */
  recentPeople: () => Promise<any[]>;
  lookupEmail: (email: string) => Promise<string | null>;
  saveLink: (personId: string, link: JiraLink) => Promise<void>;
  sprintFieldId: () => Promise<string | null>;
  fetchPage: (jql: string, fields: string[], token: string | null) => Promise<{ issues: any[]; nextPageToken: string | null }>;
  saveSnapshots: (s: JiraIssueSnapshot[]) => Promise<void>;
  upsertTask: typeof upsertPulledJiraTask;
  hasLinkedTask: (key: string) => Promise<boolean>;
}

async function recentPeople(): Promise<any[]> {
  const people = await getPeople().catch(() => [] as any[]);
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return people
    .filter((p: any) => p?._id && p.lastMeeting && Date.parse(p.lastMeeting) >= cutoff && !p.isSelf)
    .sort((a: any, b: any) => Date.parse(b.lastMeeting) - Date.parse(a.lastMeeting))
    .slice(0, PULL_MAX_ATTENDEES);
}

/**
 * Jira accountIds for the people you meet: stored id, then email lookup, then
 * unresolved (recorded so the People tab can offer "Find in Jira").
 */
export async function resolveRecentPeopleAccountIds(now: Date = new Date()): Promise<string[]> {
  const ids: string[] = [];
  for (const person of await pullDeps.recentPeople().catch(() => [] as any[])) {
    const res = await resolvePersonAccountId(person, (email) => pullDeps.lookupEmail(email), now);
    if (res.update) await pullDeps.saveLink(person._id, res.update).catch(() => undefined);
    if (res.accountId) ids.push(res.accountId);
  }
  return ids;
}

let sprintFieldCache: string | null | undefined;

const realPullDeps: PullDeps = {
  connected: isJiraConnected,
  lastSuccessMs: () => {
    const v = (getConfig() as any).lastJiraSyncAt;
    return typeof v === 'number' && v > 0 ? v : null;
  },
  markSuccess: (ms) => setConfig({ lastJiraSyncAt: ms } as any),
  defaultProject: () => (getConfig() as any).jiraDefaultProject || null,
  cloudUrl: () => (getConfig() as any).jiraTokens?.cloudUrl || null,
  myAccountId: getJiraAccountId,
  recentPeople,
  lookupEmail: findJiraAccountIdByEmail,
  saveLink: async (personId, link) => { await setPersonJiraLink(personId, link); },
  sprintFieldId: async () => {
    if (sprintFieldCache === undefined) sprintFieldCache = await findSprintFieldId();
    return sprintFieldCache;
  },
  fetchPage: (jql, fields, token) => searchJiraIssuesPage(jql, fields, token),
  saveSnapshots: saveIssueSnapshots,
  upsertTask: upsertPulledJiraTask,
  hasLinkedTask: hasTaskLinkedToJiraKey,
};
let pullDeps: PullDeps = realPullDeps;

export function __setJiraPullDepsForTests(overrides: Partial<PullDeps> | null): void {
  pullDeps = overrides ? { ...realPullDeps, ...overrides } : realPullDeps;
}

export interface PullSummary {
  ran: boolean;
  jql: string | null;
  fetched: number;
  pages: 'complete' | 'capped';
  tasks: { created: number; updated: number; merged: number; ask: number };
  error?: string;
}

let pullRunning = false;

export async function runJiraPull(now: Date = new Date()): Promise<PullSummary> {
  const empty: PullSummary = { ran: false, jql: null, fetched: 0, pages: 'complete', tasks: { created: 0, updated: 0, merged: 0, ask: 0 } };
  if (!pullDeps.connected() || pullRunning) return empty;
  pullRunning = true;
  try {
    const windowDays = computePullWindowDays(pullDeps.lastSuccessMs(), now.getTime());
    const ids = await resolveRecentPeopleAccountIds(now);
    const me = pullDeps.myAccountId();
    const jql = buildPullJql({ windowDays, attendeeAccountIds: ids.filter((id) => id !== me), defaultProject: pullDeps.defaultProject() });
    const sprintFieldId = await pullDeps.sprintFieldId().catch(() => null);
    const fields = pullFields(sprintFieldId);
    const { issues, complete } = await fetchAllPages((token) => pullDeps.fetchPage(jql, fields, token));
    const snaps = issues.map((raw) => mapIssueSnapshot(raw, { cloudUrl: pullDeps.cloudUrl(), myAccountId: me, sprintFieldId, now }));
    await pullDeps.saveSnapshots(snaps);

    const tasks = { created: 0, updated: 0, merged: 0, ask: 0 };
    for (let i = 0; i < snaps.length; i++) {
      const snap = snaps[i];
      // Only my work becomes local tasks; issues already linked always refresh.
      if (!snap.assignedToMe && !(await pullDeps.hasLinkedTask(snap.key))) continue;
      const description = issues[i]?.fields?.description ? adfToText(issues[i].fields.description) : '';
      const res = await pullDeps.upsertTask(localTaskFieldsFor(snap, description));
      if (res.kind === 'created') tasks.created++;
      else if (res.kind === 'updated') tasks.updated++;
      else if (res.kind === 'merged') tasks.merged++;
      else if (res.kind === 'ask') tasks.ask++;
    }
    pullDeps.markSuccess(now.getTime());
    void pruneIssueCache(now).catch(() => 0);
    return { ran: true, jql, fetched: issues.length, pages: complete ? 'complete' : 'capped', tasks };
  } catch (e: any) {
    log('error', 'jira:pull-failed', e?.message || String(e));
    return { ...empty, ran: true, error: e?.message || String(e) };
  } finally {
    pullRunning = false;
  }
}
