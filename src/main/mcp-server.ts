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
} from './database';
import { log } from './logger';

/**
 * Local MCP server ("Connect to AI").
 *
 * Serves the app's local meeting store to MCP clients (Claude Desktop,
 * Claude Code, etc.) over Streamable HTTP. Strictly read-only, strictly
 * loopback: the listener binds to 127.0.0.1 and every request is additionally
 * checked for a loopback peer address and a localhost Host header (defense
 * against DNS-rebinding). No auth is used: the surface never leaves the
 * machine. Caveat: on a multi-user machine, loopback is shared across OS
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
    snoozeReason: t.snoozeReason || null,
    lastMentionedAt: t.lastMentionedAt || null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt || null,
  };
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
] as const;

export function getConnectionStatusHandler(): any {
  return {
    app: 'Inwise (open source)',
    version: getAppVersion(),
    mode: 'local',
    storage: 'local NeDB files on this machine',
    access: 'read-only',
    server: `http://127.0.0.1:${currentPort ?? MCP_DEFAULT_PORT}${MCP_PATH}`,
    capabilities: [...TOOL_NAMES],
    // Reading is local; what the client does with what it reads is not. Say so
    // where a client can actually surface it.
    privacyNote:
      'This server reads only from this machine and never sends anything itself. ' +
      'Anything a client reads — transcripts especially — goes wherever that client sends it, ' +
      'including its AI provider. get_transcript is a separate tool so verbatim text can be ' +
      'approved separately from summaries.',
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
 * Registration goes through this wrapper for two reasons: every tool on this
 * server is read-only by design (readOnlyHint is applied centrally), and the
 * SDK's zod-generic inference on registerTool hits TS2589 ("excessively deep")
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
        'Full detail for one action item: untruncated description, owner when known, due date, priority, snooze state, and the meeting it came from.',
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
