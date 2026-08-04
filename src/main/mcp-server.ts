import * as http from 'http';
import { app } from 'electron';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  getMeetings,
  getMeeting,
  getTasks,
  getPeople,
  getPerson,
  getPersonAgendaContext,
  getMeetingAgendaContext,
  updateTask,
} from './database';
import { getMcpPrefs } from './config';
import {
  appendExecutionOutcome,
  buildActionExecutionSummary,
  createActionExecution,
  getActionExecution,
  listActionExecutionsByActionItem,
  recordActionStatusUpdate,
  ActionOutcomeResult,
  ExecutionArtifact,
  ProposedExecutionTool,
} from './action-execution-log';
import { log } from './logger';

/**
 * Local MCP server ("Connect to AI").
 *
 * Serves the app's local meeting store to MCP clients (Claude Desktop,
 * Claude Code, etc.) over Streamable HTTP. Reads are available while the server
 * is on. The three action-execution write tools require a separate, default-off
 * setting plus an explicit user-approval record. The listener binds to
 * 127.0.0.1 and every request is additionally checked for a loopback peer
 * address and a localhost Host header (defense against DNS-rebinding). No auth
 * is used. Caveat: on a multi-user machine, loopback is shared across OS
 * accounts, so another local user could query this port while the app runs.
 * Disable the server in Settings → Connect to AI on shared machines.
 */

export const MCP_DEFAULT_PORT = 43117;
export const MCP_PATH = '/mcp';

/** Keep single get_transcript responses comfortably under ~50 KB. */
export const TRANSCRIPT_CHUNK_CHARS = 48 * 1024;

/** How much verbatim text get_meeting will show without get_transcript's separate approval. */
export const TRANSCRIPT_EXCERPT_CHARS = 500;

const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 50;
const SNIPPET_RADIUS = 120;
const APPROVAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const APPROVAL_CLOCK_SKEW_MS = 5 * 60 * 1000;

let writebackEnabledOverride: (() => boolean) | null = null;

function isWritebackEnabled(): boolean {
  return writebackEnabledOverride ? writebackEnabledOverride() : getMcpPrefs().writebackEnabled;
}

/** Test-only/runtime override without mutating electron-store. Pass null to reset. */
export function setMcpWritebackEnabledProvider(provider: (() => boolean) | null): void {
  writebackEnabledOverride = provider;
}

// ── Tool handlers (exported for tests; no HTTP or Electron required) ─────────

function truncate(text: string, max: number): string {
  if (!text || text.length <= max) return text || '';
  return text.slice(0, max) + '…';
}

/** Extract a short snippet around the first case-insensitive match. */
export function extractSnippet(text: string, query: string): string | null {
  if (!text) return null;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + query.length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export async function searchMeetingsHandler(args: { query: string; limit?: number }): Promise<any> {
  const query = (args.query || '').trim();
  if (!query) return { error: 'query must not be empty' };
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? SEARCH_DEFAULT_LIMIT)), SEARCH_MAX_LIMIT);
  const q = query.toLowerCase();

  const meetings = await getMeetings();
  const results: any[] = [];
  for (const m of meetings) {
    const titleHit = (m.title || '').toLowerCase().includes(q);
    const summaryHit = (m.insights?.summary || '').toLowerCase().includes(q);
    const transcriptHit = !titleHit && !summaryHit && (m.transcript || '').toLowerCase().includes(q);
    if (!titleHit && !summaryHit && !transcriptHit) continue;

    results.push({
      meetingId: m._id,
      title: m.title,
      date: m.date,
      source: m.source,
      status: m.status,
      attendees: m.attendees || [],
      matchedIn: titleHit ? 'title' : summaryHit ? 'summary' : 'transcript',
      snippet: transcriptHit
        ? extractSnippet(m.transcript || '', query)
        : summaryHit
          ? extractSnippet(m.insights?.summary || '', query)
          : null,
      hasTranscript: !!m.transcript,
      actionItemCount: m.insights?.actionItems?.length || 0,
      decisionCount: m.insights?.decisions?.length || 0,
    });
    if (results.length >= limit) break;
  }
  return { query, total: results.length, results };
}

export async function getMeetingHandler(args: { meetingId: string }): Promise<any> {
  const m = await getMeeting(args.meetingId);
  if (!m) return { error: `No meeting found with id "${args.meetingId}"` };

  const transcript: string = m.transcript || '';
  return {
    meetingId: m._id,
    title: m.title,
    date: m.date,
    duration: m.duration || 0,
    source: m.source,
    status: m.status,
    attendees: m.attendees || [],
    insights: m.insights
      ? {
          summary: m.insights.summary || null,
          actionItems: m.insights.actionItems || [],
          decisions: m.insights.decisions || [],
          blockers: m.insights.blockers || [],
          commitments: m.insights.commitments || [],
          contradictions: m.insights.contradictions || [],
        }
      : null,
    // Deliberately an excerpt, not the transcript. Verbatim text is the most
    // sensitive thing here and reading it ships it to whatever model the client
    // runs on, so it lives behind its own tool (and so its own approval).
    transcript: {
      totalChars: transcript.length,
      excerpt: truncate(transcript, TRANSCRIPT_EXCERPT_CHARS),
      full: transcript.length > 0 ? 'Call get_transcript with this meetingId for the verbatim text.' : null,
    },
  };
}

export async function getTranscriptHandler(args: { meetingId: string; offset?: number }): Promise<any> {
  const m = await getMeeting(args.meetingId);
  if (!m) return { error: `No meeting found with id "${args.meetingId}"` };

  const transcript: string = m.transcript || '';
  if (!transcript) {
    return { meetingId: m._id, title: m.title, totalChars: 0, offset: 0, chunk: '', nextOffset: null };
  }
  const offset = Math.max(0, Math.floor(args.offset ?? 0));
  const chunk = transcript.slice(offset, offset + TRANSCRIPT_CHUNK_CHARS);
  const nextOffset = offset + chunk.length < transcript.length ? offset + chunk.length : null;

  return {
    meetingId: m._id,
    title: m.title,
    date: m.date,
    totalChars: transcript.length,
    offset,
    chunk,
    // Pass nextOffset back as offset to page through long transcripts.
    nextOffset,
  };
}

/**
 * Owner is a real task field but the extractor rarely fills it — on a typical
 * store only a handful of tasks carry one. The meeting's own action-item entry
 * usually does, so fall back to it and say which source the answer came from
 * rather than reporting a null the caller can't interpret.
 */
async function resolveOwner(t: any): Promise<{ owner: string | null; ownerSource: 'task' | 'meeting' | null }> {
  if (t.owner) return { owner: t.owner, ownerSource: 'task' };
  const meetingId = t.source?.type === 'meeting' ? t.source.id : t.provenance?.meetingId;
  if (!meetingId) return { owner: null, ownerSource: null };
  const m = await getMeeting(meetingId);
  const match = (m?.insights?.actionItems || []).find(
    (item: any) => (item.text || '').trim() === (t.title || '').trim()
  );
  return match?.owner ? { owner: match.owner, ownerSource: 'meeting' } : { owner: null, ownerSource: null };
}

export async function listActionItemsHandler(args: { status?: string; meetingId?: string; limit?: number }): Promise<any> {
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 50)), 200);
  // Action items live in the tasks store (auto-extracted from meeting insights
  // plus manually created ones). Include snoozed so the view is complete.
  const tasks = await getTasks({ includeSnoozed: true });
  const filtered = tasks.filter((t: any) => {
    if (args.status && t.status !== args.status) return false;
    if (args.meetingId) {
      const mid = t.source?.id || t.provenance?.meetingId;
      if (mid !== args.meetingId) return false;
    }
    return true;
  });
  return {
    total: filtered.length,
    actionItems: await Promise.all(
      filtered.slice(0, limit).map(async (t: any) => ({
        actionItemId: t._id,
        title: t.title,
        description: truncate(t.description || '', 500),
        status: t.status,
        priority: t.priority,
        dueDate: t.dueDate || null,
        ...(await resolveOwner(t)),
        sourceMeetingId: t.source?.type === 'meeting' ? t.source.id : null,
        aiExtracted: !!t.aiExtracted,
        snoozed: t.snoozedAt != null,
        createdAt: t.createdAt,
      }))
    ),
  };
}

export async function getActionItemHandler(args: { actionItemId: string }): Promise<any> {
  const tasks = await getTasks({ includeSnoozed: true });
  const t = tasks.find((x: any) => x._id === args.actionItemId);
  if (!t) return { error: `No action item found with id "${args.actionItemId}"` };
  let executionHistory: any[] = [];
  try {
    executionHistory = await listActionExecutionsByActionItem(t._id);
  } catch {
    // Older/test-only callers may use the read surface without initialising the
    // new execution log. Action-item reads should still work in that case.
  }
  return {
    actionItemId: t._id,
    title: t.title,
    // Full text here — list_action_items truncates, this tool is the detail view.
    description: t.description || null,
    status: t.status,
    priority: t.priority,
    dueDate: t.dueDate || null,
    ...(await resolveOwner(t)),
    source: t.source || null,
    sourceMeetingId: t.source?.type === 'meeting' ? t.source.id : null,
    aiExtracted: !!t.aiExtracted,
    likelyDone: !!t.likelyDone,
    snoozed: t.snoozedAt != null,
    snoozedAt: t.snoozedAt || null,
    snoozeReason: t.snoozedReason || null,
    lastMentionedAt: t.lastMentionedAt || null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt || null,
    executionRecommendation: buildActionExecutionRecommendation(t),
    executionHistoryTotal: executionHistory.length,
    executionHistory: executionHistory.slice(0, 10).map(toPublicExecution),
  };
}

function toPublicExecution(execution: any): any {
  return {
    executionId: execution._id,
    actionItemId: execution.actionItemId,
    actionItemTitle: execution.actionItemTitle,
    objective: execution.objective,
    plan: execution.plan || [],
    proposedTools: execution.proposedTools || [],
    client: execution.client,
    approval: execution.approval,
    status: execution.status,
    outcomes: (execution.outcomes || []).map(toPublicOutcome),
    auditTrail: (execution.auditTrail || []).map((event: any) => ({
      eventId: event.id,
      type: event.type,
      at: event.at,
      client: event.client,
      details: event.details,
    })),
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt,
  };
}

function toPublicOutcome(outcome: any): any {
  return {
    outcomeId: outcome.id,
    result: outcome.result,
    summary: outcome.summary,
    artifacts: outcome.artifacts || [],
    remainingWork: outcome.remainingWork || null,
    client: outcome.client,
    createdAt: outcome.createdAt,
  };
}

export function buildActionExecutionRecommendation(task: any): {
  source: 'inwise-starter';
  objective: string;
  suggestedSteps: string[];
  suggestedToolCategories: string[];
  approvalReminder: string;
} {
  const title = String(task?.title || '').trim();
  const text = `${title} ${task?.description || ''}`.toLowerCase();
  let deliverable = 'a concrete draft or completed result';
  let toolCategories = ['general productivity'];

  if (/\b(email|e-mail|reply|respond|send|follow[- ]?up)\b/.test(text)) {
    deliverable = 'a reviewed message draft, then the approved send';
    toolCategories = ['email'];
  } else if (/\b(schedule|calendar|book|invite|meeting)\b/.test(text)) {
    deliverable = 'a proposed time and attendee list, then an approved calendar change';
    toolCategories = ['calendar'];
  } else if (/\b(doc|document|proposal|brief|plan|spec|report|notes|memo)\b/.test(text)) {
    deliverable = 'a reviewable document draft with a shareable link';
    toolCategories = ['documents'];
  } else if (/\b(jira|ticket|issue|bug|linear|asana|task)\b/.test(text)) {
    deliverable = 'a proposed issue update with the exact fields to change';
    toolCategories = ['work tracking'];
  }

  const contextStep = task?.source?.type === 'meeting' && task?.source?.id
    ? 'Review the linked meeting summary and only fetch verbatim transcript text if exact wording is necessary.'
    : 'Confirm the intended outcome, audience, and constraints with the user.';
  const ownershipStep = task?.owner
    ? `Keep ${task.owner} as the named owner unless the user changes ownership.`
    : 'Confirm who owns the final follow-through.';
  const dueStep = task?.dueDate
    ? `Work toward the recorded due date (${task.dueDate}).`
    : 'Ask whether there is a deadline before committing externally.';

  return {
    source: 'inwise-starter',
    objective: `Produce ${deliverable} for “${title || 'this action item'}”.`,
    suggestedSteps: [contextStep, ownershipStep, dueStep, 'Show the exact plan and external tools to the user before acting.'],
    suggestedToolCategories: toolCategories,
    approvalReminder: 'Call start_action_execution only after the user explicitly approves the plan and tool scope.',
  };
}

async function findActionItem(actionItemId: string): Promise<any | null> {
  const tasks = await getTasks({ includeSnoozed: true });
  return tasks.find((t: any) => t._id === actionItemId) || null;
}

function writebackDisabled(): any {
  return {
    error:
      'Action writeback is disabled. In Inwise, open Settings → Connect to AI and enable “Allow approved action writeback”.',
    code: 'WRITEBACK_DISABLED',
  };
}

function validateApproval(approval: {
  confirmed: boolean;
  approvedBy: string;
  approvedAt: string;
  scope: string;
  approvedTools?: string[];
}, proposedTools: ProposedExecutionTool[]): string | null {
  if (approval?.confirmed !== true) return 'The client must obtain explicit user approval before starting execution.';
  if (!approval.approvedBy?.trim()) return 'approval.approvedBy must identify who approved the execution.';
  if (!approval.scope?.trim()) return 'approval.scope must describe exactly what the user approved.';
  const approvedAtMs = Date.parse(approval.approvedAt);
  if (!Number.isFinite(approvedAtMs)) return 'approval.approvedAt must be a valid ISO timestamp.';
  const now = Date.now();
  if (approvedAtMs > now + APPROVAL_CLOCK_SKEW_MS) return 'approval.approvedAt cannot be in the future.';
  if (approvedAtMs < now - APPROVAL_MAX_AGE_MS) return 'Approval is older than 24 hours; ask the user to approve this execution again.';
  const approved = new Set((approval.approvedTools || []).map((name) => name.trim()).filter(Boolean));
  const unapproved = proposedTools.map((tool) => tool.name).filter((name) => !approved.has(name));
  if (unapproved.length > 0) return `These proposed tools are not in approval.approvedTools: ${unapproved.join(', ')}`;
  return null;
}

function normalizeArtifacts(artifacts: ExecutionArtifact[]): { artifacts?: ExecutionArtifact[]; error?: string } {
  const normalized: ExecutionArtifact[] = [];
  for (const artifact of artifacts || []) {
    try {
      const url = new URL(artifact.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return { error: `Artifact URL must use http or https: ${artifact.url}` };
      }
      normalized.push({
        type: artifact.type.trim(),
        label: artifact.label.trim(),
        url: url.toString(),
        externalId: artifact.externalId?.trim() || null,
      });
    } catch {
      return { error: `Invalid artifact URL: ${artifact.url}` };
    }
  }
  return { artifacts: normalized };
}

export interface StartActionExecutionArgs {
  actionItemId: string;
  objective: string;
  plan: string[];
  proposedTools?: ProposedExecutionTool[];
  client: string;
  approval: {
    confirmed: boolean;
    approvedBy: string;
    approvedAt: string;
    scope: string;
    approvedTools?: string[];
  };
  idempotencyKey: string;
}

export async function startActionExecutionHandler(args: StartActionExecutionArgs): Promise<any> {
  if (!isWritebackEnabled()) return writebackDisabled();
  const task = await findActionItem(args.actionItemId);
  if (!task) return { error: `No active action item found with id "${args.actionItemId}"` };
  if (task.snoozedAt != null) {
    return { error: 'This action item is snoozed. Bring it back in Inwise before starting execution.' };
  }
  const proposedTools = (args.proposedTools || []).map((tool) => ({
    name: tool.name.trim(),
    purpose: tool.purpose.trim(),
    target: tool.target?.trim() || null,
    dataShared: tool.dataShared?.trim() || null,
  }));
  const approvalError = validateApproval(args.approval, proposedTools);
  if (approvalError) return { error: approvalError, code: 'APPROVAL_REQUIRED' };

  try {
    const result = await createActionExecution({
      actionItemId: task._id,
      actionItemTitle: task.title,
      objective: args.objective.trim(),
      plan: args.plan.map((step) => step.trim()),
      proposedTools,
      client: args.client.trim(),
      approval: {
        approvedBy: args.approval.approvedBy.trim(),
        approvedAt: new Date(args.approval.approvedAt).toISOString(),
        scope: args.approval.scope.trim(),
        approvedTools: [...new Set((args.approval.approvedTools || []).map((name) => name.trim()).filter(Boolean))],
      },
      idempotencyKey: args.idempotencyKey.trim(),
    });
    const projection = buildActionExecutionSummary(result.execution);
    await updateTask(task._id, { executionSummary: projection, updatedAt: result.execution.updatedAt });
    return {
      execution: toPublicExecution(result.execution),
      replayed: result.replayed,
      actionItem: { actionItemId: task._id, title: task.title, status: task.status },
      next: 'Perform only the approved external work, then call append_action_outcome with the result and artifact links.',
    };
  } catch (err: any) {
    return { error: err?.message || String(err) };
  }
}

export interface AppendActionOutcomeArgs {
  executionId: string;
  result: ActionOutcomeResult;
  summary: string;
  artifacts?: ExecutionArtifact[];
  remainingWork?: string;
  client: string;
  idempotencyKey: string;
}

export async function appendActionOutcomeHandler(args: AppendActionOutcomeArgs): Promise<any> {
  if (!isWritebackEnabled()) return writebackDisabled();
  const artifactResult = normalizeArtifacts(args.artifacts || []);
  if (artifactResult.error) return { error: artifactResult.error };
  try {
    const result = await appendExecutionOutcome(args.executionId, {
      idempotencyKey: args.idempotencyKey.trim(),
      result: args.result,
      summary: args.summary.trim(),
      artifacts: artifactResult.artifacts || [],
      remainingWork: args.remainingWork?.trim() || null,
      client: args.client.trim(),
    });
    const projection = buildActionExecutionSummary(result.execution);
    await updateTask(result.execution.actionItemId, {
      executionSummary: projection,
      updatedAt: result.execution.updatedAt,
    });
    return {
      execution: toPublicExecution(result.execution),
      outcome: toPublicOutcome(result.outcome),
      replayed: result.replayed,
      next:
        args.result === 'completed'
          ? 'If the action item itself is now complete, call update_action_status.'
          : 'Continue only within the approved scope; append another outcome when the state changes.',
    };
  } catch (err: any) {
    return { error: err?.message || String(err) };
  }
}

export interface UpdateActionStatusArgs {
  actionItemId: string;
  executionId: string;
  status: 'todo' | 'inProgress' | 'completed' | 'cancelled';
  note?: string;
  expectedUpdatedAt?: string;
  client: string;
  idempotencyKey: string;
}

export async function updateActionStatusHandler(args: UpdateActionStatusArgs): Promise<any> {
  if (!isWritebackEnabled()) return writebackDisabled();
  const task = await findActionItem(args.actionItemId);
  if (!task) return { error: `No active action item found with id "${args.actionItemId}"` };
  const execution = await getActionExecution(args.executionId);
  if (!execution) return { error: `No action execution found with id "${args.executionId}"` };
  const priorCall = execution.auditTrail.find(
    (event) => event.type === 'action-status-updated' && event.idempotencyKey === args.idempotencyKey.trim(),
  );
  if (priorCall) {
    if (
      execution.actionItemId !== args.actionItemId ||
      execution.client !== args.client.trim() ||
      priorCall.details.toStatus !== args.status ||
      (priorCall.details.note || null) !== (args.note?.trim() || null)
    ) {
      return { error: 'idempotencyKey was already used for a different status update' };
    }
    return {
      actionItem: {
        actionItemId: task._id,
        title: task.title,
        status: task.status,
        updatedAt: task.updatedAt || null,
      },
      execution: toPublicExecution(execution),
      replayed: true,
    };
  }
  if (args.expectedUpdatedAt && (task.updatedAt || null) !== args.expectedUpdatedAt) {
    return {
      error: 'The action item changed after the client read it. Read get_action_item again before updating status.',
      code: 'STALE_ACTION_ITEM',
      currentUpdatedAt: task.updatedAt || null,
      currentStatus: task.status,
    };
  }
  if (
    args.status === 'completed' &&
    !execution.outcomes.some((outcome) => outcome.result === 'completed')
  ) {
    return {
      error: 'Cannot mark the action item completed until append_action_outcome records a completed result.',
      code: 'COMPLETED_OUTCOME_REQUIRED',
    };
  }
  try {
    const recorded = await recordActionStatusUpdate(args.executionId, {
      actionItemId: args.actionItemId,
      fromStatus: task.status,
      toStatus: args.status,
      note: args.note?.trim() || null,
      client: args.client.trim(),
      idempotencyKey: args.idempotencyKey.trim(),
    });
    const now = recorded.execution.updatedAt;
    const updated = await updateTask(task._id, {
      status: args.status,
      likelyDone: false,
      updatedAt: now,
      executionSummary: buildActionExecutionSummary(recorded.execution),
    });
    return {
      actionItem: {
        actionItemId: updated._id,
        title: updated.title,
        status: updated.status,
        updatedAt: updated.updatedAt,
      },
      execution: toPublicExecution(recorded.execution),
      replayed: recorded.replayed,
    };
  } catch (err: any) {
    return { error: err?.message || String(err) };
  }
}

export async function listPeopleHandler(args: { search?: string; limit?: number }): Promise<any> {
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 50)), 200);
  // Nameless rows exist in the store (partial imports). They can never match a
  // meeting attendee, so they'd only be noise in an agent's list.
  const people = (await getPeople(args.search?.trim() || undefined)).filter((p: any) =>
    ((p.name || '').trim().length > 0)
  );
  return {
    total: people.length,
    people: people.slice(0, limit).map((p: any) => ({
      personId: p._id,
      name: p.name,
      email: p.email || null,
      role: p.role || null,
      company: p.company || null,
      meetingCount: p.meetingCount,
      lastMeeting: p.lastMeeting,
      daysSinceLastContact: p.daysSinceLastContact,
      actionItemCount: p.actionItemCount,
    })),
  };
}

export async function getPersonHandler(args: { personId: string }): Promise<any> {
  const p = await getPerson(args.personId);
  if (!p) return { error: `No person found with id "${args.personId}"` };
  return {
    personId: p._id,
    name: p.name,
    email: p.email || null,
    role: p.role || null,
    company: p.company || null,
    bio: p.bio || null,
    relationshipInsights: p.relationshipInsights || [],
    summary: p.summary,
    nudges: p.nudges || [],
    pendingActionItems: p.pendingActionItems || [],
    commitments: p.commitments || [],
    // Meeting bodies stay out — call get_meeting with a meetingId for those.
    recentMeetings: (p.communications || []).slice(0, 10).map((c: any) => ({
      meetingId: c._id,
      title: c.title,
      date: c.date,
      summary: c.summary,
      keyDecisions: c.keyDecisions || [],
    })),
  };
}

// ── Meeting prep ─────────────────────────────────────────────────────────────

/** How many source meetings to cite per attendee. */
const SOURCES_PER_ATTENDEE = 3;
const SOURCE_EXCERPT_CHARS = 300;

function toSource(m: any): any {
  return {
    meetingId: m._id,
    title: m.title,
    date: m.date,
    // The excerpt is what the agenda claim rests on. Summary first; a transcript
    // opening is the fallback so an unprocessed meeting still cites something.
    excerpt: m.insights?.summary
      ? truncate(m.insights.summary, SOURCE_EXCERPT_CHARS)
      : m.transcript
        ? truncate(m.transcript, SOURCE_EXCERPT_CHARS)
        : null,
    decisions: (m.insights?.decisions || []).map((d: any) => d.text || d),
  };
}

function matchesAttendee(m: any, name: string): boolean {
  const needle = name.toLowerCase();
  return (m.attendees || []).some((a: string) => {
    if (!a) return false;
    const lower = a.toLowerCase();
    return lower.includes(needle) || needle.includes(lower);
  });
}

/** Cite the meetings behind an agenda, grouped by the attendee they came from. */
async function sourcesForAttendees(names: string[]): Promise<any[]> {
  if (names.length === 0) return [];
  const all = await getMeetings();
  const sorted = [...all].sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return names.map((name) => ({
    attendee: name,
    meetings: sorted.filter((m: any) => matchesAttendee(m, name)).slice(0, SOURCES_PER_ATTENDEE).map(toSource),
  }));
}

/**
 * One prep tool for both shapes of the question: "what should I raise with this
 * person" and "what should I know before this meeting". Pass a personId, an
 * eventId from list_upcoming_meetings, or a title plus attendee names.
 *
 * Every response pairs the prose brief with `sources` — meeting id, title, date
 * and the excerpt each claim rests on — so nothing in the agenda is unattributable.
 */
export async function prepareMeetingHandler(args: {
  personId?: string;
  eventId?: string;
  title?: string;
  attendees?: string[];
}): Promise<any> {
  if (args.personId) {
    const agenda = await getPersonAgendaContext(args.personId);
    if (agenda == null) return { error: `No person found with id "${args.personId}"` };
    const person = await getPerson(args.personId);
    return {
      subject: 'person',
      personId: args.personId,
      name: person?.name ?? null,
      agenda,
      sources: [
        {
          attendee: person?.name ?? null,
          meetings: (person?.communications || []).slice(0, SOURCES_PER_ATTENDEE).map((c: any) => ({
            meetingId: c._id,
            title: c.title,
            date: c.date,
            excerpt: c.summary ? truncate(c.summary, SOURCE_EXCERPT_CHARS) : null,
            decisions: c.keyDecisions || [],
          })),
        },
      ],
    };
  }

  let title = (args.title || '').trim();
  let attendees = args.attendees || [];

  if (args.eventId) {
    const events = upcomingEventsProvider ? upcomingEventsProvider() : [];
    const match = events.find((e) => e.id === args.eventId);
    if (!match) {
      return { error: `No upcoming meeting found with eventId "${args.eventId}". Call list_upcoming_meetings first.` };
    }
    title = match.title;
    attendees = match.attendees || [];
  }

  if (!title) {
    return {
      error:
        'Pass personId (from list_people), eventId (from list_upcoming_meetings), or title plus attendees.',
    };
  }

  const agenda = await getMeetingAgendaContext(title, attendees);
  return { subject: 'meeting', title, attendees, agenda, sources: await sourcesForAttendees(attendees) };
}

// ── Upcoming calendar events ─────────────────────────────────────────────────
//
// The calendar watcher holds its polled events in memory in the main process.
// It is injected rather than imported so this module keeps its no-Electron,
// no-network import graph and stays unit-testable (see mcp-server.test.ts).

export interface UpcomingEventLike {
  id: string;
  title: string;
  startTime: Date | string;
  endTime?: Date | string;
  attendees?: string[];
  meetingLink?: string;
}

let upcomingEventsProvider: (() => UpcomingEventLike[]) | null = null;

export function setUpcomingEventsProvider(fn: (() => UpcomingEventLike[]) | null): void {
  upcomingEventsProvider = fn;
}

const UPCOMING_DEFAULT_HOURS = 24;
const UPCOMING_MAX_HOURS = 24 * 14;

function upcomingWithin(hours: number, now: number): UpcomingEventLike[] {
  const events = upcomingEventsProvider ? upcomingEventsProvider() : [];
  const until = now + hours * 3600_000;
  return events
    .filter((e) => {
      const start = new Date(e.startTime).getTime();
      return Number.isFinite(start) && start >= now && start <= until;
    })
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
}

export async function listUpcomingMeetingsHandler(args: { withinHours?: number; limit?: number }): Promise<any> {
  if (!upcomingEventsProvider) {
    return {
      error:
        'No calendar is connected in the Inwise app. Add one in Settings → Calendars, ' +
        'or use search_meetings for meetings already recorded.',
    };
  }
  const hours = Math.min(Math.max(1, Math.floor(args.withinHours ?? UPCOMING_DEFAULT_HOURS)), UPCOMING_MAX_HOURS);
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 20)), 100);
  const events = upcomingWithin(hours, Date.now());
  // An empty cache and an empty window look the same from here; say so rather
  // than letting a caller read "no meetings" as "calendar checked, nothing due".
  const cacheEmpty = (upcomingEventsProvider?.() ?? []).length === 0;
  return {
    withinHours: hours,
    total: events.length,
    ...(cacheEmpty
      ? { note: 'No calendar events are cached — either no calendar is connected in Settings → Calendars, or none has synced yet.' }
      : {}),
    meetings: events.slice(0, limit).map((e) => ({
      eventId: e.id,
      title: e.title,
      startTime: new Date(e.startTime).toISOString(),
      endTime: e.endTime ? new Date(e.endTime).toISOString() : null,
      attendees: e.attendees || [],
      hasMeetingLink: !!e.meetingLink,
    })),
  };
}

function getAppVersion(): string {
  try {
    const v = (app as any)?.getVersion?.();
    if (v) return v;
  } catch {
    /* not running under Electron (tests) */
  }
  try {
    // dist/main/mcp-server.js → ../../package.json (repo root / packaged app root)
    return require('../../package.json').version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The advertised tool surface, in one place. buildMcpServer registers exactly
 * these names and get_connection_status reports them, so a client can ask what
 * this build supports instead of inferring it from the app version.
 */
export const TOOL_NAMES = [
  'search_meetings',
  'get_meeting',
  'get_transcript',
  'list_action_items',
  'get_action_item',
  'list_people',
  'get_person',
  'list_upcoming_meetings',
  'prepare_meeting',
  'get_connection_status',
  'start_action_execution',
  'append_action_outcome',
  'update_action_status',
] as const;

export function getConnectionStatusHandler(): any {
  const writebackEnabled = isWritebackEnabled();
  return {
    app: 'Inwise (open source)',
    version: getAppVersion(),
    mode: 'local',
    storage: 'local NeDB files on this machine',
    access: writebackEnabled ? 'read plus approved action writeback' : 'read-only',
    server: `http://127.0.0.1:${currentPort ?? MCP_DEFAULT_PORT}${MCP_PATH}`,
    capabilities: [...TOOL_NAMES],
    actionWriteback: {
      enabled: writebackEnabled,
      externalToolCaller: 'the connected MCP host (for example Claude, Codex, or OpenWorker)',
      inwiseRole: 'validate the linked action item and store the approved plan, outcome, artifacts, and status',
    },
    // Reading is local; what the client does with what it reads is not. Say so
    // where a client can actually surface it.
    privacyNote:
      'This server reads only from this machine and never sends anything itself. ' +
      'Anything a client reads — transcripts especially — goes wherever that client sends it, ' +
      'including its AI provider. get_transcript is a separate tool so verbatim text can be ' +
      'approved separately from summaries. Action writeback is off by default; when enabled, ' +
      'the client must record explicit approval before an execution can start.',
    calendarConnected: upcomingEventsProvider ? upcomingEventsProvider().length > 0 : false,
  };
}

// ── Loopback / Host-header guards (exported for tests) ───────────────────────

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  if (addr === '::1') return true;
  const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return v4.startsWith('127.');
}

export function isAllowedHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  // Strip port. Handles "127.0.0.1:43117", "localhost:43117", "[::1]:43117".
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']') === -1 ? host.length : host.indexOf(']'))
    : host.split(':')[0];
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

// ── MCP server assembly ───────────────────────────────────────────────────────

function toText(result: any): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    ...(result && result.error ? { isError: true } : {}),
  };
}

/**
 * Registration goes through this wrapper so read-only annotations cannot drift,
 * and because the SDK's zod-generic inference on registerTool hits TS2589
 * ("excessively deep")
 * under this repo's TypeScript 5.3 — the cast sidesteps the inference while
 * mcp-server.test.ts verifies the actual wire behavior (tool list, annotations,
 * schemas, calls).
 */
function registerReadOnlyTool(
  server: McpServer,
  name: string,
  cfg: { title: string; description: string; inputSchema: Record<string, z.ZodTypeAny> },
  handler: (args: any) => any
): void {
  (server.registerTool as any)(
    name,
    { ...cfg, annotations: { readOnlyHint: true } },
    async (args: any) => toText(await handler(args))
  );
}

function registerWriteTool(
  server: McpServer,
  name: string,
  cfg: { title: string; description: string; inputSchema: Record<string, z.ZodTypeAny> },
  handler: (args: any) => any
): void {
  (server.registerTool as any)(
    name,
    {
      ...cfg,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args: any) => toText(await handler(args))
  );
}

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'inwise-local', version: getAppVersion() });

  registerReadOnlyTool(
    server,
    'search_meetings',
    {
      title: 'Search meetings',
      description:
        'Keyword search over the meetings recorded or imported on this machine. Matches titles, AI summaries, and transcript text. Returns meeting ids to pass to get_meeting.',
      inputSchema: {
        query: z.string().describe('Keyword or phrase to search for'),
        limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).optional().describe(`Max results (default ${SEARCH_DEFAULT_LIMIT})`),
      },
    },
    searchMeetingsHandler
  );

  registerReadOnlyTool(
    server,
    'get_meeting',
    {
      title: 'Get meeting',
      description:
        'One meeting: metadata, attendees, and AI insights (summary, action items, decisions, blockers, commitments), plus a short transcript excerpt. For the verbatim transcript call get_transcript, which is separate so it can be approved separately.',
      inputSchema: {
        meetingId: z.string().describe('Meeting id from search_meetings'),
      },
    },
    getMeetingHandler
  );

  registerReadOnlyTool(
    server,
    'get_transcript',
    {
      title: 'Get transcript',
      description:
        "The verbatim transcript of one meeting, paged — pass nextOffset back as offset for the next chunk. This is the raw record of what people said; reading it sends that text wherever this client sends its context, including its AI provider. Prefer get_meeting's summary and excerpt unless the exact wording matters.",
      inputSchema: {
        meetingId: z.string().describe('Meeting id from search_meetings'),
        offset: z.number().int().min(0).optional().describe('Character offset into the transcript (default 0)'),
      },
    },
    getTranscriptHandler
  );

  registerReadOnlyTool(
    server,
    'list_action_items',
    {
      title: 'List action items',
      description:
        'List action items tracked on this machine (auto-extracted from meetings plus manually created). Filter by status or source meeting. Owner is reported when one is known — most items have none, and ownerSource says whether it came from the item or from the meeting it was extracted from.',
      inputSchema: {
        status: z.string().optional().describe('Filter by status, e.g. "todo" or "done"'),
        meetingId: z.string().optional().describe('Only items extracted from this meeting'),
        limit: z.number().int().min(1).max(200).optional().describe('Max results (default 50)'),
      },
    },
    listActionItemsHandler
  );

  registerReadOnlyTool(
    server,
    'get_action_item',
    {
      title: 'Get action item',
      description:
        'Full detail for one action item: untruncated description, owner when known, due date, priority, snooze state, source meeting, an Inwise starter recommendation, and recent approved execution outcomes.',
      inputSchema: {
        actionItemId: z.string().describe('Action item id from list_action_items'),
      },
    },
    getActionItemHandler
  );

  registerReadOnlyTool(
    server,
    'list_people',
    {
      title: 'List people',
      description:
        'List the people tracked on this machine, with how often you meet them and how long since the last contact. Returns person ids to pass to get_person and prepare_meeting.',
      inputSchema: {
        search: z.string().optional().describe('Filter by name, email, or company'),
        limit: z.number().int().min(1).max(200).optional().describe('Max results (default 50)'),
      },
    },
    listPeopleHandler
  );

  registerReadOnlyTool(
    server,
    'get_person',
    {
      title: 'Get person',
      description:
        'One person in depth: role, bio, relationship insights, open action items and commitments involving them, nudges (overdue commitments, stale tasks), and recent meetings together.',
      inputSchema: {
        personId: z.string().describe('Person id from list_people'),
      },
    },
    getPersonHandler
  );

  registerReadOnlyTool(
    server,
    'list_upcoming_meetings',
    {
      title: 'List upcoming meetings',
      description:
        'Meetings coming up on the calendars connected in the Inwise app, soonest first, with attendees. Returns event ids to pass to prepare_meeting. Use for day-ahead or pre-meeting prep.',
      inputSchema: {
        withinHours: z
          .number()
          .int()
          .min(1)
          .max(UPCOMING_MAX_HOURS)
          .optional()
          .describe(`Look-ahead window in hours (default ${UPCOMING_DEFAULT_HOURS})`),
        limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
      },
    },
    listUpcomingMeetingsHandler
  );

  registerReadOnlyTool(
    server,
    'prepare_meeting',
    {
      title: 'Prepare for a meeting',
      description:
        'A prepared agenda for a 1:1 or a team meeting: what you last discussed with each attendee, recent decisions, unresolved blockers, and what each side owes. Every response also returns `sources` — meeting id, title, date, and the excerpt each point rests on — so nothing in the agenda is unattributable. Pass personId for a 1:1, eventId from list_upcoming_meetings, or a title plus attendee names.',
      inputSchema: {
        personId: z.string().optional().describe('Person id from list_people, for a 1:1'),
        eventId: z.string().optional().describe('Event id from list_upcoming_meetings'),
        title: z.string().optional().describe('Meeting title, if not passing personId or eventId'),
        attendees: z.array(z.string()).optional().describe('Attendee names, if not passing personId or eventId'),
      },
    },
    prepareMeetingHandler
  );

  registerReadOnlyTool(
    server,
    'get_connection_status',
    {
      title: 'Check connection',
      description:
        'Confirm the local Inwise app is running, report its version, list which tools this build supports, and say whether a calendar is connected.',
      inputSchema: {},
    },
    getConnectionStatusHandler
  );

  registerWriteTool(
    server,
    'start_action_execution',
    {
      title: 'Start approved action execution',
      description:
        'Record a user-approved plan for acting on one Inwise action item. This does not call external tools itself: the connected MCP host performs only the approved work, then reports the result with append_action_outcome. Action writeback must be enabled in Inwise Settings.',
      inputSchema: {
        actionItemId: z.string().min(1).max(200).describe('Action item id from list_action_items or get_action_item'),
        objective: z.string().min(1).max(2000).describe('Concrete outcome this execution is meant to produce'),
        plan: z.array(z.string().min(1).max(1000)).min(1).max(12).describe('Steps shown to and approved by the user'),
        proposedTools: z
          .array(
            z.object({
              name: z.string().min(1).max(200).describe('External tool or connector the MCP host plans to use'),
              purpose: z.string().min(1).max(1000).describe('Why this tool is needed'),
              target: z.string().max(500).nullable().optional().describe('Account, document, recipient, or system being changed'),
              dataShared: z.string().max(1000).nullable().optional().describe('Meeting/action data that will be sent to the tool'),
            })
          )
          .max(12)
          .optional()
          .describe('External tools covered by the user approval; empty is allowed for local-only work'),
        client: z.string().min(1).max(200).describe('Calling MCP host, e.g. claude-desktop, codex, or openworker'),
        approval: z.object({
          confirmed: z.literal(true).describe('Client attestation that the user explicitly approved this exact plan and tool scope'),
          approvedBy: z.string().min(1).max(200).describe('Name or local identity of the approving user'),
          approvedAt: z.string().datetime().describe('ISO timestamp from the approval interaction; must be within the last 24 hours'),
          scope: z.string().min(1).max(2000).describe('Plain-language boundary of what the user approved'),
          approvedTools: z.array(z.string().min(1).max(200)).max(12).optional().describe('Every proposed tool name the user approved'),
        }),
        idempotencyKey: z.string().min(8).max(200).describe('Unique stable key for safe retry of this exact start request'),
      },
    },
    startActionExecutionHandler
  );

  registerWriteTool(
    server,
    'append_action_outcome',
    {
      title: 'Append action outcome',
      description:
        'Write the external result back to the approved Inwise execution: a concise summary, artifact links, and any remaining work. This creates the local memory/audit record; it does not itself send email, edit documents, or call other services.',
      inputSchema: {
        executionId: z.string().min(1).max(200).describe('Execution id returned by start_action_execution'),
        result: z.enum(['progress', 'completed', 'failed']).describe('State of this execution after the reported outcome'),
        summary: z.string().min(1).max(5000).describe('What actually happened; do not claim work that was not verified'),
        artifacts: z
          .array(
            z.object({
              type: z.string().min(1).max(100).describe('Artifact kind, e.g. document, email, ticket'),
              label: z.string().min(1).max(300).describe('Human-readable artifact label'),
              url: z.string().url().max(2000).describe('http(s) link to the created or changed artifact'),
              externalId: z.string().max(300).nullable().optional().describe('Provider record id, if available'),
            })
          )
          .max(25)
          .optional(),
        remainingWork: z.string().max(3000).optional().describe('Anything still outstanding or requiring user follow-through'),
        client: z.string().min(1).max(200).describe('Must match the client that started the execution'),
        idempotencyKey: z.string().min(8).max(200).describe('Unique stable key for safe retry of this exact outcome'),
      },
    },
    appendActionOutcomeHandler
  );

  registerWriteTool(
    server,
    'update_action_status',
    {
      title: 'Update Inwise action status',
      description:
        'Update the local Inwise action item after an approved execution. Link every change to its execution, use expectedUpdatedAt to avoid overwriting a newer edit, and only mark completed when the reported outcome supports it.',
      inputSchema: {
        actionItemId: z.string().min(1).max(200).describe('Action item id linked to the execution'),
        executionId: z.string().min(1).max(200).describe('Execution id returned by start_action_execution'),
        status: z.enum(['todo', 'inProgress', 'completed', 'cancelled']).describe('New local Inwise status'),
        note: z.string().max(2000).optional().describe('Why the status changed'),
        expectedUpdatedAt: z.string().datetime().optional().describe('updatedAt from get_action_item for optimistic concurrency'),
        client: z.string().min(1).max(200).describe('Must match the client that started the execution'),
        idempotencyKey: z.string().min(8).max(200).describe('Unique stable key for safe retry of this exact status update'),
      },
    },
    updateActionStatusHandler
  );

  return server;
}

// ── HTTP lifecycle ────────────────────────────────────────────────────────────

let httpServer: http.Server | null = null;
let currentPort: number | null = null;
let lastError: string | null = null;

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Defense in depth: the listener is bound to 127.0.0.1, but reject any
  // non-loopback peer and any non-localhost Host header (DNS rebinding).
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Loopback connections only' }));
    return;
  }
  if (!isAllowedHostHeader(req.headers.host)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid Host header' }));
    return;
  }

  const pathname = (req.url || '').split('?')[0];
  if (pathname !== MCP_PATH) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. The MCP endpoint is ' + MCP_PATH }));
    return;
  }

  if (req.method !== 'POST') {
    // Stateless mode: no SSE stream to resume, no session to delete.
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed. This stateless MCP endpoint only accepts POST.' },
        id: null,
      })
    );
    return;
  }

  // Stateless: fresh server + transport per request, torn down when the
  // response closes. Keeps requests fully isolated for concurrent clients.
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err: any) {
    log('error', 'mcp:request', err?.message || String(err));
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        })
      );
    }
  }
}

export async function startMcpServer(port?: number): Promise<{ ok: boolean; port: number | null; error?: string }> {
  const desiredPort = port ?? currentPort ?? MCP_DEFAULT_PORT;
  await stopMcpServer();

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      void handleRequest(req, res);
    });
    server.on('error', (err: any) => {
      lastError =
        err?.code === 'EADDRINUSE'
          ? `Port ${desiredPort} is already in use — pick a different port.`
          : err?.message || String(err);
      log('error', 'mcp:server', lastError!);
      httpServer = null;
      currentPort = null;
      resolve({ ok: false, port: null, error: lastError! });
    });
    server.listen(desiredPort, '127.0.0.1', () => {
      httpServer = server;
      const addr = server.address();
      currentPort = typeof addr === 'object' && addr ? addr.port : desiredPort;
      lastError = null;
      log('info', 'mcp:server', `Local MCP server listening on http://127.0.0.1:${currentPort}${MCP_PATH}`);
      resolve({ ok: true, port: currentPort });
    });
  });
}

export async function stopMcpServer(): Promise<void> {
  if (!httpServer) return;
  const server = httpServer;
  httpServer = null;
  currentPort = null;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Don't wait on open keep-alive sockets.
    server.closeAllConnections?.();
  });
  log('info', 'mcp:server', 'Local MCP server stopped');
}

export function getMcpStatus(): { running: boolean; port: number | null; error: string | null } {
  return { running: httpServer !== null, port: currentPort, error: lastError };
}
