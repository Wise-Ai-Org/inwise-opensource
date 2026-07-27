/**
 * Task-mention dedup: retrieval, context signals, LLM classification, bands.
 *
 * Pure decision logic — no database imports. Callers (database.ts saveInsights
 * loop, main.ts voice-memo pipeline) fetch tasks/meetings and apply the
 * resulting decision. The only side effect here is the BYOK LLM call, which is
 * injectable for tests via __setLlmForTests.
 */

import { getConfig } from './config';
import { log } from './logger';
import { textSimilarity } from './text-similarity';
import {
  AUTO_MERGE_THRESHOLD,
  ASK_THRESHOLD,
  RETRIEVAL_FLOOR,
  RETRIEVAL_TOP_K,
  DONE_LOOKBACK_DAYS,
  STALE_CANDIDATE_DAYS,
  REPETITION_NUDGE_WINDOW_DAYS,
  REPETITION_NUDGE_COUNT,
  FALLBACK_JACCARD_THRESHOLD,
  CONTEXT_SIGNAL_BOOST,
  MATCH_PROMPT_VERSION,
} from './dedup-constants';

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Types ────────────────────────────────────────────────────────────────────

export type MentionSourceType = 'meeting' | 'voice_note';

/** One recorded mention of a task (US-002). */
export interface TaskMention {
  id: string;
  sourceType: MentionSourceType;
  sourceId: string | null;
  /** Display name of the source (meeting title / "Voice note") for the thread UI. */
  sourceTitle?: string | null;
  excerpt: string;
  occurredAt: string; // ISO
  /** Snapshot of the merged-away item so undo/split can recreate it (US-010). */
  mergedItem?: {
    title: string;
    description?: string;
    owner?: string | null;
    deadline?: string | null;
  };
}

export interface NewMentionItem {
  title: string;
  description?: string;
}

export interface DedupCandidate {
  taskId: string;
  title: string;
  description: string;
  retrievalScore: number; // raw Jaccard, floor applies to this
  rankScore: number;      // retrievalScore + context boosts, ordering only
  wasDone: boolean;
  sharedAttendees: string[];
  sameSeries: boolean;
}

export interface ClassifierResult {
  index: number;
  verdict: 'same_task' | 'related_but_different' | 'new';
  confidence: number; // 0-100
}

export type MatchDecision =
  | { kind: 'none' }
  | {
      kind: 'auto_merge';
      taskId: string;
      taskTitle: string;
      confidence: number | null; // null when reached via Jaccard fallback
      retrievalScore: number;
      viaFallback?: boolean;
    }
  | {
      kind: 'ask';
      taskId: string;
      taskTitle: string;
      wasDone: boolean;
      confidence: number;
      retrievalScore: number;
    }
  | {
      kind: 'new';
      confidence: number | null;
      retrievalScore: number | null;
      candidateTaskId: string | null;
    };

// ── Series / attendee context helpers (US-012, OQ4) ─────────────────────────

/**
 * Recurring-series id for a meeting. Prefers the persisted `seriesUid` (written
 * at calendar-sync time since OQ4); falls back to splitting the composite
 * `<uid>_<epochMs>` calendarEventId on its last underscore for pre-existing rows.
 */
export function getSeriesUid(meeting: { seriesUid?: string | null; calendarEventId?: string | null } | null | undefined): string | null {
  if (!meeting) return null;
  if (meeting.seriesUid) return String(meeting.seriesUid);
  const composite = meeting.calendarEventId;
  if (!composite) return null;
  const idx = composite.lastIndexOf('_');
  if (idx <= 0) return null;
  const suffix = composite.slice(idx + 1);
  if (!/^\d{10,}$/.test(suffix)) return null; // only trust the <uid>_<epochMs> shape
  return composite.slice(0, idx);
}

/**
 * Case-insensitive attendee-name overlap, same containment posture as the
 * identity matching in database.ts (getPerson/computePeopleStats).
 */
export function attendeeOverlap(a: string[] | null | undefined, b: string[] | null | undefined): string[] {
  const shared: string[] = [];
  if (!a?.length || !b?.length) return shared;
  for (const nameA of a) {
    if (!nameA) continue;
    const la = nameA.toLowerCase();
    const hit = b.some(nameB => {
      if (!nameB) return false;
      const lb = nameB.toLowerCase();
      return la === lb || la.includes(lb) || lb.includes(la);
    });
    if (hit) shared.push(nameA);
  }
  return shared;
}

function isDoneStatus(status: string | undefined): boolean {
  return status === 'done' || status === 'completed';
}

function lastActivityMs(task: any): number {
  const stamps = [task.updatedAt, task.lastMentionedAt, task.createdAt]
    .map(s => (s ? new Date(s).getTime() : NaN))
    .filter(n => !Number.isNaN(n));
  return stamps.length ? Math.max(...stamps) : 0;
}

// ── Retrieval (US-003 / US-008 / US-012) ────────────────────────────────────

export interface RetrievalContext {
  nowMs?: number;
  /** Meeting doc the new mention came from; null/undefined for voice memos (skip context signals). */
  sourceMeeting?: { _id?: string; attendees?: string[]; seriesUid?: string | null; calendarEventId?: string | null } | null;
  /** Meeting docs by _id, for candidate tasks' source meetings. */
  meetingsById?: Map<string, any>;
}

export function retrieveCandidates(
  item: NewMentionItem,
  tasks: any[],
  ctx: RetrievalContext = {},
): DedupCandidate[] {
  const nowMs = ctx.nowMs ?? Date.now();
  const newText = `${item.title || ''} ${item.description || ''}`.trim();
  if (!newText) return [];

  const newSeries = ctx.sourceMeeting ? getSeriesUid(ctx.sourceMeeting) : null;
  const newAttendees = ctx.sourceMeeting?.attendees || [];
  const useContext = !!ctx.sourceMeeting; // voice-memo mentions skip both signals

  const out: DedupCandidate[] = [];
  for (const t of tasks) {
    if (!t || t.archivedAt) continue;
    const done = isDoneStatus(t.status);
    const ageMs = nowMs - lastActivityMs(t);
    if (done) {
      // Widening pass: recently-done only, flagged wasDone (US-008)
      if (ageMs > DONE_LOOKBACK_DAYS * DAY_MS) continue;
    } else {
      if (ageMs > STALE_CANDIDATE_DAYS * DAY_MS) continue;
    }

    const candText = `${t.title || ''} ${t.description || ''}`.trim();
    const score = textSimilarity(newText, candText);
    if (score < RETRIEVAL_FLOOR) continue;

    let sharedAttendees: string[] = [];
    let sameSeries = false;
    if (useContext && t.source?.type === 'meeting' && t.source.id && ctx.meetingsById) {
      const candMeeting = ctx.meetingsById.get(t.source.id);
      if (candMeeting) {
        sharedAttendees = attendeeOverlap(newAttendees, candMeeting.attendees);
        const candSeries = getSeriesUid(candMeeting);
        sameSeries = !!newSeries && !!candSeries && newSeries === candSeries;
      }
    }

    const rankScore = score
      + (sharedAttendees.length > 0 ? CONTEXT_SIGNAL_BOOST : 0)
      + (sameSeries ? CONTEXT_SIGNAL_BOOST : 0);

    out.push({
      taskId: t._id,
      title: t.title || '',
      description: t.description || '',
      retrievalScore: score,
      rankScore,
      wasDone: done,
      sharedAttendees,
      sameSeries,
    });
  }

  return out.sort((a, b) => b.rankScore - a.rankScore).slice(0, RETRIEVAL_TOP_K);
}

// ── LLM classification (US-004) ─────────────────────────────────────────────

export const MATCH_SYSTEM_PROMPT = `You are a task de-duplication judge (prompt ${MATCH_PROMPT_VERSION}). The user's meeting notes produced a NEW ITEM. You are given a short list of the user's EXISTING TASKS that look lexically similar.

For EVERY candidate, decide whether the NEW ITEM refers to the same underlying piece of work:
- "same_task": the same task mentioned again, even if worded completely differently.
- "related_but_different": same topic or project, but a distinct piece of work.
- "new": unrelated.

Context hints may accompany a candidate (shared meeting attendees, same recurring meeting series). Treat them as supporting evidence, never as sufficient on their own.

Return ONLY valid JSON, no markdown fences, exactly this shape:
{"results":[{"index":0,"verdict":"same_task","confidence":92}]}
Include one entry per candidate index. "confidence" is an integer 0-100 for the verdict you chose.`;

export type LlmCall = (systemPrompt: string, userMessage: string) => Promise<string>;

let llmOverride: LlmCall | null = null;

/** Test hook: replace the BYOK provider call. Pass null to restore. */
export function __setLlmForTests(fn: LlmCall | null): void {
  llmOverride = fn;
}

/** Human-readable model label for the transparency line (US-007). */
export function providerModelLabel(provider?: string): string {
  const p = provider || getConfig().apiProvider;
  return p === 'openai' ? 'GPT-4o mini' : 'Claude Haiku';
}

async function callConfiguredLlm(systemPrompt: string, userMessage: string): Promise<string> {
  const config = getConfig();
  if (!config.apiKey) throw new Error('API key not configured');

  if (config.apiProvider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    if (!res.ok) throw new Error(`Claude API error: ${await res.text()}`);
    const data = await res.json() as any;
    return data.content?.[0]?.text || '';
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API error: ${await res.text()}`);
  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

function buildUserMessage(item: NewMentionItem, candidates: DedupCandidate[]): string {
  const lines: string[] = [];
  lines.push(`NEW ITEM: "${item.title}"`);
  if (item.description) lines.push(`Details: ${item.description}`);
  lines.push('');
  lines.push('EXISTING TASKS:');
  candidates.forEach((c, i) => {
    const hints: string[] = [];
    if (c.sharedAttendees.length) hints.push(`shared attendees: ${c.sharedAttendees.slice(0, 5).join(', ')}`);
    if (c.sameSeries) hints.push('same recurring meeting series');
    if (c.wasDone) hints.push('recently marked done');
    const hintText = hints.length ? ` [${hints.join('; ')}]` : '';
    const desc = c.description ? ` — ${c.description.slice(0, 140)}` : '';
    lines.push(`${i}. "${c.title}"${desc}${hintText}`);
  });
  return lines.join('\n');
}

/**
 * Classify the new item against candidates with the user's configured BYOK
 * model. Throws on any failure (network, malformed JSON) — callers fall back
 * to the legacy Jaccard behavior (FR-12).
 */
export async function classifyCandidates(
  item: NewMentionItem,
  candidates: DedupCandidate[],
): Promise<ClassifierResult[]> {
  const call = llmOverride || callConfiguredLlm;
  const raw = await call(MATCH_SYSTEM_PROMPT, buildUserMessage(item, candidates));
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = JSON.parse(stripped);
  const results = Array.isArray(parsed?.results) ? parsed.results : null;
  if (!results) throw new Error('classifier: missing results array');

  const out: ClassifierResult[] = [];
  for (const r of results) {
    const index = Number(r?.index);
    const verdict = String(r?.verdict || '');
    const confidence = Number(r?.confidence);
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) continue;
    if (verdict !== 'same_task' && verdict !== 'related_but_different' && verdict !== 'new') continue;
    if (Number.isNaN(confidence)) continue;
    out.push({ index, verdict: verdict as ClassifierResult['verdict'], confidence: Math.max(0, Math.min(100, confidence)) });
  }
  if (out.length === 0) throw new Error('classifier: no valid results');
  return out;
}

// ── Decision orchestration (US-005 / US-008) ────────────────────────────────

export async function decideMention(
  item: NewMentionItem,
  tasks: any[],
  ctx: RetrievalContext = {},
): Promise<MatchDecision> {
  const candidates = retrieveCandidates(item, tasks, ctx);
  if (candidates.length === 0) return { kind: 'none' }; // create exactly as today

  let results: ClassifierResult[];
  try {
    results = await classifyCandidates(item, candidates);
  } catch (e: any) {
    log('info', 'task-dedup:classify-fallback', e?.message || String(e));
    // Legacy Jaccard-0.65 behavior. wasDone candidates never auto-merge.
    const top = candidates
      .filter(c => !c.wasDone)
      .sort((a, b) => b.retrievalScore - a.retrievalScore)[0];
    if (top && top.retrievalScore >= FALLBACK_JACCARD_THRESHOLD) {
      return {
        kind: 'auto_merge',
        taskId: top.taskId,
        taskTitle: top.title,
        confidence: null,
        retrievalScore: top.retrievalScore,
        viaFallback: true,
      };
    }
    return { kind: 'none' };
  }

  const sameTask = results
    .filter(r => r.verdict === 'same_task')
    .sort((a, b) => b.confidence - a.confidence);

  if (sameTask.length === 0) {
    const top = candidates[0];
    const topResult = results.find(r => r.index === 0) || results[0];
    return {
      kind: 'new',
      confidence: topResult?.confidence ?? null,
      retrievalScore: top?.retrievalScore ?? null,
      candidateTaskId: top?.taskId ?? null,
    };
  }

  const best = sameTask[0];
  const cand = candidates[best.index];

  if (cand.wasDone) {
    // Never auto-merge a done task regardless of confidence (US-008)
    if (best.confidence >= ASK_THRESHOLD) {
      return {
        kind: 'ask',
        taskId: cand.taskId,
        taskTitle: cand.title,
        wasDone: true,
        confidence: best.confidence,
        retrievalScore: cand.retrievalScore,
      };
    }
    return { kind: 'new', confidence: best.confidence, retrievalScore: cand.retrievalScore, candidateTaskId: cand.taskId };
  }

  if (best.confidence >= AUTO_MERGE_THRESHOLD) {
    return {
      kind: 'auto_merge',
      taskId: cand.taskId,
      taskTitle: cand.title,
      confidence: best.confidence,
      retrievalScore: cand.retrievalScore,
    };
  }
  if (best.confidence >= ASK_THRESHOLD) {
    return {
      kind: 'ask',
      taskId: cand.taskId,
      taskTitle: cand.title,
      wasDone: false,
      confidence: best.confidence,
      retrievalScore: cand.retrievalScore,
    };
  }
  return { kind: 'new', confidence: best.confidence, retrievalScore: cand.retrievalScore, candidateTaskId: cand.taskId };
}

// ── Mention thread + repetition nudge helpers (US-009 / US-014) ─────────────

export interface ThreadEntry {
  id: string;
  sourceType: MentionSourceType;
  sourceId: string | null;
  sourceTitle: string;
  excerpt: string;
  occurredAt: string;
  canSplit: boolean;
}

/**
 * Chronological mention thread for the task detail view. Tasks with fewer than
 * two mentions return [] — single-mention tasks render exactly as today.
 */
export function buildMentionThread(task: { taskMentions?: TaskMention[] | null }): ThreadEntry[] {
  const mentions = task?.taskMentions || [];
  if (mentions.length < 2) return [];
  return [...mentions]
    .sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime())
    .map(m => ({
      id: m.id,
      sourceType: m.sourceType,
      sourceId: m.sourceId ?? null,
      sourceTitle: m.sourceTitle || (m.sourceType === 'voice_note' ? 'Voice note' : 'Meeting'),
      excerpt: m.excerpt || '',
      occurredAt: m.occurredAt,
      canSplit: !!m.mergedItem,
    }));
}

export interface RepetitionNudge {
  show: boolean;
  count: number; // mentions within the window
}

/**
 * "Raised N× this week" chip (US-014). Counts taskMentions with occurredAt in
 * the nudge window (mentionCount has no timestamps). Dismissal stores the
 * total mention count at dismiss time in `nudgeDismissedAtCount`; the chip
 * stays hidden until the count increases again.
 */
export function computeRepetitionNudge(
  task: { taskMentions?: TaskMention[] | null; nudgeDismissedAtCount?: number | null; status?: string },
  nowMs: number = Date.now(),
): RepetitionNudge {
  const mentions = task?.taskMentions || [];
  const windowStart = nowMs - REPETITION_NUDGE_WINDOW_DAYS * DAY_MS;
  const count = mentions.filter(m => {
    const t = new Date(m.occurredAt).getTime();
    return !Number.isNaN(t) && t >= windowStart && t <= nowMs;
  }).length;
  if (isDoneStatus(task?.status)) return { show: false, count };
  const dismissedAt = task?.nudgeDismissedAtCount;
  const suppressed = dismissedAt != null && mentions.length <= dismissedAt;
  return { show: count >= REPETITION_NUDGE_COUNT && !suppressed, count };
}
