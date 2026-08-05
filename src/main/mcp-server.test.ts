import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import Datastore from '@seald-io/nedb';
import { __setMeetingsDbForTests, __setPeopleDbForTests, __setTasksDbForTests } from './database';
import { __setActionExecutionsDbForTests } from './action-execution-log';
import {
  appendActionOutcomeHandler,
  buildActionExecutionRecommendation,
  MCP_PATH,
  TRANSCRIPT_CHUNK_CHARS,
  extractSnippet,
  getMcpStatus,
  getActionItemHandler,
  getConnectionStatusHandler,
  getMeetingHandler,
  getPersonHandler,
  getTranscriptHandler,
  isAllowedHostHeader,
  isLoopbackAddress,
  listActionItemsHandler,
  listPeopleHandler,
  listUpcomingMeetingsHandler,
  prepareMeetingHandler,
  searchMeetingsHandler,
  setMcpWritebackEnabledProvider,
  setUpcomingEventsProvider,
  startActionExecutionHandler,
  startMcpServer,
  stopMcpServer,
  TOOL_NAMES,
  TRANSCRIPT_EXCERPT_CHARS,
  updateActionStatusHandler,
} from './mcp-server';

// ── HTTP helper (raw http.request so we control Host and Accept headers) ─────

function rawRequest(
  port: number,
  opts: { method: string; path: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method,
        path: opts.path,
        headers: opts.headers,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function mcpPost(port: number, payload: any, extraHeaders: Record<string, string> = {}) {
  return rawRequest(port, {
    method: 'POST',
    path: MCP_PATH,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-03-26',
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });
}

/** Unwrap a tools/call JSON-RPC response into the parsed tool result object. */
function parseToolResult(body: string): any {
  const rpc = JSON.parse(body);
  assert.ok(rpc.result, `expected result in ${body.slice(0, 300)}`);
  const text = rpc.result.content?.[0]?.text;
  assert.ok(typeof text === 'string', 'tool result has text content');
  return JSON.parse(text);
}

async function run(): Promise<void> {
  // ── Guards: loopback peer address ───────────────────────────────────────────
  {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('127.0.0.53'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('192.168.1.5'), false);
    assert.equal(isLoopbackAddress('::ffff:192.168.1.5'), false);
    assert.equal(isLoopbackAddress('10.0.0.1'), false);
    assert.equal(isLoopbackAddress(undefined), false);
    assert.equal(isLoopbackAddress(''), false);
  }

  // ── Guards: Host header (DNS rebinding) ─────────────────────────────────────
  {
    assert.equal(isAllowedHostHeader('127.0.0.1:43117'), true);
    assert.equal(isAllowedHostHeader('127.0.0.1'), true);
    assert.equal(isAllowedHostHeader('localhost:43117'), true);
    assert.equal(isAllowedHostHeader('localhost'), true);
    assert.equal(isAllowedHostHeader('[::1]:43117'), true);
    assert.equal(isAllowedHostHeader('evil.com'), false);
    assert.equal(isAllowedHostHeader('evil.com:43117'), false);
    assert.equal(isAllowedHostHeader('127.0.0.1.evil.com'), false);
    assert.equal(isAllowedHostHeader('localhost.evil.com'), false);
    assert.equal(isAllowedHostHeader(undefined), false);
    assert.equal(isAllowedHostHeader(''), false);
  }

  // ── extractSnippet ──────────────────────────────────────────────────────────
  {
    assert.equal(extractSnippet('', 'x'), null);
    assert.equal(extractSnippet('nothing here', 'zebra'), null);
    const hit = extractSnippet('short text with KEYWORD inside', 'keyword');
    assert.ok(hit && hit.includes('KEYWORD'), 'case-insensitive snippet keeps original casing');
    const long = 'a'.repeat(500) + 'needle' + 'b'.repeat(500);
    const snip = extractSnippet(long, 'needle')!;
    assert.ok(snip.includes('needle'));
    assert.ok(snip.startsWith('…') && snip.endsWith('…'), 'long snippets are elided on both sides');
    assert.ok(snip.length < 300, 'snippet stays short');
  }

  // ── Fixture store (in-memory NeDB, same shape database.ts writes) ───────────
  const meetingsDb = new Datastore<any>();
  const tasksDb = new Datastore<any>();
  const peopleDb = new Datastore<any>();
  const actionExecutionsDb = new Datastore<any>();
  await meetingsDb.loadDatabaseAsync();
  await tasksDb.loadDatabaseAsync();
  await peopleDb.loadDatabaseAsync();
  await actionExecutionsDb.loadDatabaseAsync();
  await actionExecutionsDb.ensureIndexAsync({ fieldName: 'startIdempotencyKey', unique: true });
  __setMeetingsDbForTests(meetingsDb);
  __setTasksDbForTests(tasksDb);
  __setPeopleDbForTests(peopleDb);
  __setActionExecutionsDbForTests(actionExecutionsDb);
  setMcpWritebackEnabledProvider(() => false);

  const longTranscript = 'line of discussion. '.repeat(4000); // 80,000 chars > one chunk
  const shortTranscript =
    'Alex: We agreed to ship the billing revamp first. Priya: Yes, billing before analytics.';

  await meetingsDb.insertAsync([
    {
      _id: 'm-roadmap',
      title: 'Q3 Roadmap Review',
      date: '2026-07-21T10:00:00.000Z',
      duration: 1800,
      attendees: ['Alex Chen', 'Priya Patel'],
      transcript: shortTranscript,
      status: 'processed',
      source: 'desktop_recording',
      insights: {
        summary: 'Team prioritized the billing revamp over analytics for Q3.',
        actionItems: [{ text: 'Draft billing migration plan', owner: 'Alex Chen' }],
        decisions: [{ text: 'Billing revamp ships before analytics' }],
        blockers: [],
        commitments: [],
        contradictions: [],
      },
      createdAt: '2026-07-21T10:35:00.000Z',
    },
    {
      _id: 'm-long',
      title: 'All Hands',
      date: '2026-07-20T17:00:00.000Z',
      duration: 3600,
      attendees: ['Alex Chen'],
      transcript: longTranscript,
      status: 'transcribed',
      source: 'zoom_import',
      insights: null,
      createdAt: '2026-07-20T18:05:00.000Z',
    },
    {
      _id: 'm-empty',
      title: 'Design sync (calendar only)',
      date: '2026-07-19T09:00:00.000Z',
      duration: 900,
      attendees: ['Priya Patel'],
      transcript: null,
      status: 'calendar_sync',
      source: 'calendar',
      insights: null,
      createdAt: '2026-07-19T09:20:00.000Z',
    },
  ]);

  await tasksDb.insertAsync([
    {
      _id: 't-1',
      title: 'Draft billing migration plan',
      description: '',
      status: 'todo',
      priority: 'high',
      dueDate: '2026-07-28',
      source: { type: 'meeting', id: 'm-roadmap' },
      aiExtracted: true,
      approval: { status: 'pending' },
      archivedAt: null,
      snoozedAt: null,
      createdAt: '2026-07-21T10:36:00.000Z',
    },
    {
      _id: 't-2',
      title: 'Send all-hands notes',
      description: 'Recap for the team',
      status: 'done',
      priority: 'medium',
      dueDate: null,
      source: { type: 'meeting', id: 'm-long' },
      aiExtracted: true,
      approval: { status: 'auto_approved' },
      archivedAt: null,
      snoozedAt: null,
      createdAt: '2026-07-20T18:10:00.000Z',
    },
    {
      _id: 't-3',
      title: 'Book offsite venue',
      description: '',
      status: 'todo',
      priority: 'low',
      dueDate: null,
      source: { type: 'manual' },
      aiExtracted: false,
      approval: { status: 'auto_approved' },
      archivedAt: null,
      snoozedAt: '2026-07-22T00:00:00.000Z',
      createdAt: '2026-07-18T12:00:00.000Z',
    },
    {
      _id: 't-owned',
      title: 'Own the analytics spec',
      description: '',
      status: 'todo',
      priority: 'medium',
      dueDate: null,
      owner: 'Priya Patel',
      source: { type: 'manual' },
      aiExtracted: false,
      approval: { status: 'auto_approved' },
      archivedAt: null,
      snoozedAt: null,
      createdAt: '2026-07-19T12:00:00.000Z',
    },
    {
      _id: 't-archived',
      title: 'Old archived task',
      description: '',
      status: 'done',
      priority: 'low',
      dueDate: null,
      source: { type: 'manual' },
      aiExtracted: false,
      approval: { status: 'auto_approved' },
      archivedAt: '2026-06-01T00:00:00.000Z',
      snoozedAt: null,
      createdAt: '2026-05-01T12:00:00.000Z',
    },
  ]);

  await peopleDb.insertAsync([
    {
      _id: 'p-alex',
      name: 'Alex Chen',
      email: 'alex@example.com',
      company: 'Acme',
      role: 'Engineering Lead',
      bio: 'Owns the billing platform.',
      notes: null,
      relationshipInsights: ['Prefers written context before a decision'],
      archived: false,
      trackedBy: true,
      createdAt: '2026-06-01T00:00:00.000Z',
    },
    {
      _id: 'p-priya',
      name: 'Priya Patel',
      email: 'priya@example.com',
      company: 'Acme',
      role: 'Design',
      bio: null,
      notes: null,
      relationshipInsights: [],
      archived: false,
      trackedBy: true,
      createdAt: '2026-06-01T00:00:00.000Z',
    },
    {
      _id: 'p-nameless',
      name: null,
      email: null,
      company: null,
      role: null,
      bio: null,
      notes: null,
      relationshipInsights: [],
      archived: false,
      trackedBy: true,
      createdAt: '2026-06-15T00:00:00.000Z',
    },
    {
      _id: 'p-archived',
      name: 'Former Colleague',
      email: null,
      company: null,
      role: null,
      bio: null,
      notes: null,
      relationshipInsights: [],
      archived: true,
      trackedBy: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ]);

  // ── search_meetings ─────────────────────────────────────────────────────────
  {
    // Title match
    const byTitle = await searchMeetingsHandler({ query: 'roadmap' });
    assert.equal(byTitle.total, 1);
    assert.equal(byTitle.results[0].meetingId, 'm-roadmap');
    assert.equal(byTitle.results[0].matchedIn, 'title');
    assert.equal(byTitle.results[0].hasTranscript, true);
    assert.equal(byTitle.results[0].actionItemCount, 1);

    // Transcript match produces a snippet
    const byTranscript = await searchMeetingsHandler({ query: 'billing before analytics' });
    assert.equal(byTranscript.total, 1);
    assert.equal(byTranscript.results[0].matchedIn, 'transcript');
    assert.ok(byTranscript.results[0].snippet.includes('billing before analytics'));

    // Summary match
    const bySummary = await searchMeetingsHandler({ query: 'prioritized the billing' });
    assert.equal(bySummary.results[0].matchedIn, 'summary');

    // Case-insensitive
    const upper = await searchMeetingsHandler({ query: 'ROADMAP' });
    assert.equal(upper.total, 1);

    // No match
    const none = await searchMeetingsHandler({ query: 'quarterly zebra migration' });
    assert.equal(none.total, 0);

    // Empty query rejected
    const empty = await searchMeetingsHandler({ query: '   ' });
    assert.ok(empty.error);

    // Limit respected
    const limited = await searchMeetingsHandler({ query: 'line of discussion', limit: 1 });
    assert.equal(limited.results.length, 1);
  }

  // ── get_meeting (summary surface — no verbatim transcript) ──────────────────
  {
    const full = await getMeetingHandler({ meetingId: 'm-roadmap' });
    assert.equal(full.title, 'Q3 Roadmap Review');
    assert.deepEqual(full.attendees, ['Alex Chen', 'Priya Patel']);
    assert.equal(full.insights.summary, 'Team prioritized the billing revamp over analytics for Q3.');
    assert.equal(full.insights.decisions.length, 1);

    // The privacy boundary: get_meeting never returns the full transcript, only a
    // capped excerpt, and points at the separately-approved tool for the rest.
    assert.equal(full.transcript.totalChars, shortTranscript.length);
    assert.ok(!('chunk' in full.transcript), 'get_meeting no longer serves transcript chunks');
    assert.ok(full.transcript.full.includes('get_transcript'));

    const long = await getMeetingHandler({ meetingId: 'm-long' });
    assert.equal(long.transcript.totalChars, longTranscript.length);
    assert.ok(
      long.transcript.excerpt.length <= TRANSCRIPT_EXCERPT_CHARS + 1,
      'excerpt is capped regardless of transcript length (+1 for the ellipsis)'
    );
    assert.ok(long.transcript.excerpt.endsWith('…'), 'a clipped excerpt is marked as clipped');

    // Meeting without transcript
    const noTranscript = await getMeetingHandler({ meetingId: 'm-empty' });
    assert.equal(noTranscript.transcript.totalChars, 0);
    assert.equal(noTranscript.transcript.full, null, 'nothing to escalate to when there is no transcript');
    assert.equal(noTranscript.insights, null);

    // Unknown id
    const missing = await getMeetingHandler({ meetingId: 'nope' });
    assert.ok(missing.error);
  }

  // ── get_transcript (the separately-approved verbatim surface) ───────────────
  {
    const short = await getTranscriptHandler({ meetingId: 'm-roadmap' });
    assert.equal(short.chunk, shortTranscript);
    assert.equal(short.nextOffset, null, 'short transcript fits in one chunk');

    // Long transcript pages in <=48KB chunks
    const page1 = await getTranscriptHandler({ meetingId: 'm-long' });
    assert.equal(page1.chunk.length, TRANSCRIPT_CHUNK_CHARS);
    assert.equal(page1.nextOffset, TRANSCRIPT_CHUNK_CHARS);
    assert.equal(page1.totalChars, longTranscript.length);

    const page2 = await getTranscriptHandler({ meetingId: 'm-long', offset: page1.nextOffset });
    assert.equal(page2.chunk.length, longTranscript.length - TRANSCRIPT_CHUNK_CHARS);
    assert.equal(page2.nextOffset, null);
    assert.equal(page1.chunk + page2.chunk, longTranscript, 'chunks reassemble losslessly');

    const none = await getTranscriptHandler({ meetingId: 'm-empty' });
    assert.equal(none.totalChars, 0);
    assert.equal(none.chunk, '');
    assert.equal(none.nextOffset, null);

    const missing = await getTranscriptHandler({ meetingId: 'nope' });
    assert.ok(missing.error);
  }

  // ── list_action_items ───────────────────────────────────────────────────────
  {
    const all = await listActionItemsHandler({});
    assert.equal(all.total, 4, 'archived tasks excluded, snoozed included');
    assert.ok(all.actionItems.some((t: any) => t.actionItemId === 't-3' && t.snoozed === true));

    const todo = await listActionItemsHandler({ status: 'todo' });
    assert.equal(todo.total, 3);
    assert.ok(todo.actionItems.every((t: any) => t.status === 'todo'));

    const byMeeting = await listActionItemsHandler({ meetingId: 'm-roadmap' });
    assert.equal(byMeeting.total, 1);
    assert.equal(byMeeting.actionItems[0].actionItemId, 't-1');
    assert.equal(byMeeting.actionItems[0].sourceMeetingId, 'm-roadmap');
    // t-1 carries no owner of its own; the meeting's action item names Alex Chen.
    assert.equal(byMeeting.actionItems[0].owner, 'Alex Chen');
    assert.equal(byMeeting.actionItems[0].ownerSource, 'meeting');

    const limited = await listActionItemsHandler({ limit: 1 });
    assert.equal(limited.actionItems.length, 1);
    assert.equal(limited.total, 4, 'total reflects all matches even when page is capped');
  }

  // ── get_action_item ─────────────────────────────────────────────────────────
  {
    const t = await getActionItemHandler({ actionItemId: 't-2' });
    assert.equal(t.title, 'Send all-hands notes');
    assert.equal(t.description, 'Recap for the team', 'detail view is untruncated');
    assert.equal(t.status, 'done');
    assert.equal(t.sourceMeetingId, 'm-long');
    assert.equal(t.aiExtracted, true);
    // m-long has no insights, so there is nowhere to borrow an owner from
    assert.equal(t.owner, null);
    assert.equal(t.ownerSource, null);

    // Owner on the item itself wins over the meeting's
    const owned = await getActionItemHandler({ actionItemId: 't-1' });
    assert.equal(owned.owner, 'Alex Chen');
    assert.equal(owned.ownerSource, 'meeting', 'borrowed from the source meeting when the item has none');

    const explicit = await getActionItemHandler({ actionItemId: 't-owned' });
    assert.equal(explicit.owner, 'Priya Patel');
    assert.equal(explicit.ownerSource, 'task');

    // Snoozed tasks are reachable by id, with the snooze surfaced
    const snoozed = await getActionItemHandler({ actionItemId: 't-3' });
    assert.equal(snoozed.snoozed, true);
    assert.equal(snoozed.snoozedAt, '2026-07-22T00:00:00.000Z');
    assert.equal(snoozed.sourceMeetingId, null, 'manual items have no source meeting');

    // Archived items stay invisible, same as list_action_items
    const archived = await getActionItemHandler({ actionItemId: 't-archived' });
    assert.ok(archived.error);

    const missing = await getActionItemHandler({ actionItemId: 'nope' });
    assert.ok(missing.error);
  }

  // ── list_people ─────────────────────────────────────────────────────────────
  {
    const all = await listPeopleHandler({});
    assert.equal(all.total, 2, 'archived and nameless people excluded');
    assert.ok(
      !all.people.some((p: any) => p.personId === 'p-nameless'),
      'nameless rows never reach an agent — they cannot match a meeting attendee'
    );
    const alex = all.people.find((p: any) => p.personId === 'p-alex');
    assert.equal(alex.name, 'Alex Chen');
    assert.equal(alex.role, 'Engineering Lead');
    assert.equal(alex.meetingCount, 2, 'attendee match across roadmap + all-hands');
    assert.ok(typeof alex.daysSinceLastContact === 'number');

    const search = await listPeopleHandler({ search: 'priya' });
    assert.equal(search.total, 1);
    assert.equal(search.people[0].personId, 'p-priya');

    const limited = await listPeopleHandler({ limit: 1 });
    assert.equal(limited.people.length, 1);
    assert.equal(limited.total, 2, 'total reflects all matches even when page is capped');
  }

  // ── get_person ──────────────────────────────────────────────────────────────
  {
    const p = await getPersonHandler({ personId: 'p-alex' });
    assert.equal(p.name, 'Alex Chen');
    assert.equal(p.bio, 'Owns the billing platform.');
    assert.deepEqual(p.relationshipInsights, ['Prefers written context before a decision']);
    assert.equal(p.summary.totalMeetings, 2);
    assert.ok(Array.isArray(p.nudges));
    assert.ok(p.recentMeetings.some((m: any) => m.meetingId === 'm-roadmap'));
    assert.ok(
      p.recentMeetings.every((m: any) => !('transcript' in m)),
      'transcripts are not inlined — get_meeting serves those'
    );

    const missing = await getPersonHandler({ personId: 'nope' });
    assert.ok(missing.error);
  }

  // ── prepare_meeting: the 1:1 shape ──────────────────────────────────────────
  {
    const a = await prepareMeetingHandler({ personId: 'p-alex' });
    assert.equal(a.subject, 'person');
    assert.equal(a.personId, 'p-alex');
    assert.equal(a.name, 'Alex Chen');
    assert.ok(a.agenda.includes('Alex Chen'));
    assert.ok(a.agenda.includes('Q3 Roadmap Review'), 'agenda cites the meetings it drew on');
    assert.ok(a.agenda.includes('Engineering Lead'));

    // Every agenda is source-linked: id, title, date, and the excerpt behind it.
    assert.equal(a.sources.length, 1);
    assert.equal(a.sources[0].attendee, 'Alex Chen');
    const cited = a.sources[0].meetings;
    assert.ok(cited.length > 0, 'the brief cites the meetings it came from');
    const roadmap = cited.find((m: any) => m.meetingId === 'm-roadmap');
    assert.ok(roadmap, 'sources carry meeting ids so a client can link back');
    assert.equal(roadmap.title, 'Q3 Roadmap Review');
    assert.equal(roadmap.date, '2026-07-21T10:00:00.000Z');
    assert.ok(roadmap.excerpt.includes('billing revamp'), 'excerpt is the supporting text');
    assert.deepEqual(roadmap.decisions, ['Billing revamp ships before analytics']);

    const missing = await prepareMeetingHandler({ personId: 'nope' });
    assert.ok(missing.error);
  }

  // ── list_upcoming_meetings ──────────────────────────────────────────────────
  {
    // No provider wired (app started without a calendar watcher) → explicit error,
    // never a silent empty list that reads as "nothing scheduled".
    setUpcomingEventsProvider(null);
    const unwired = await listUpcomingMeetingsHandler({});
    assert.ok(unwired.error && unwired.error.includes('calendar'));

    const now = Date.now();
    const soon = new Date(now + 60 * 60_000);        // in 1 hour
    const tomorrow = new Date(now + 30 * 3600_000);  // in 30 hours
    const past = new Date(now - 3600_000);           // an hour ago
    setUpcomingEventsProvider(() => [
      {
        id: 'e-past',
        title: 'Already happened',
        startTime: past,
        endTime: new Date(past.getTime() + 1800_000),
        attendees: ['Alex Chen'],
      },
      {
        id: 'e-tomorrow',
        title: 'Design review',
        startTime: tomorrow,
        endTime: new Date(tomorrow.getTime() + 1800_000),
        attendees: ['Priya Patel'],
      },
      {
        id: 'e-soon',
        title: 'Billing sync',
        startTime: soon,
        endTime: new Date(soon.getTime() + 1800_000),
        attendees: ['Alex Chen', 'Priya Patel'],
        meetingLink: 'https://zoom.us/j/123',
      },
    ]);

    const next24 = await listUpcomingMeetingsHandler({});
    assert.equal(next24.total, 1, 'past events and events past the window are excluded');
    assert.equal(next24.meetings[0].eventId, 'e-soon');
    assert.equal(next24.meetings[0].hasMeetingLink, true);
    assert.deepEqual(next24.meetings[0].attendees, ['Alex Chen', 'Priya Patel']);
    assert.ok(!next24.note, 'no advisory note when the cache has events');

    const next48 = await listUpcomingMeetingsHandler({ withinHours: 48 });
    assert.equal(next48.total, 2);
    assert.deepEqual(
      next48.meetings.map((m: any) => m.eventId),
      ['e-soon', 'e-tomorrow'],
      'soonest first'
    );

    const limited = await listUpcomingMeetingsHandler({ withinHours: 48, limit: 1 });
    assert.equal(limited.meetings.length, 1);
    assert.equal(limited.total, 2);

    // Wired but empty cache: distinguishable from "checked, nothing due"
    setUpcomingEventsProvider(() => []);
    const empty = await listUpcomingMeetingsHandler({});
    assert.equal(empty.total, 0);
    assert.ok(empty.note && empty.note.includes('No calendar events are cached'));
  }

  // ── prepare_meeting: the upcoming-meeting shape ─────────────────────────────
  {
    const now = Date.now();
    setUpcomingEventsProvider(() => [
      {
        id: 'e-soon',
        title: 'Billing sync',
        startTime: new Date(now + 3600_000),
        endTime: new Date(now + 5400_000),
        attendees: ['Alex Chen', 'Priya Patel'],
      },
    ]);

    const byEvent = await prepareMeetingHandler({ eventId: 'e-soon' });
    assert.equal(byEvent.subject, 'meeting');
    assert.equal(byEvent.title, 'Billing sync');
    assert.deepEqual(byEvent.attendees, ['Alex Chen', 'Priya Patel']);
    assert.ok(byEvent.agenda.includes('Alex Chen'));
    assert.ok(byEvent.agenda.includes('Priya Patel'));
    assert.ok(byEvent.agenda.includes('Q3 Roadmap Review'), 'pulls history for the attendees');

    // Sources are grouped per attendee, each meeting carrying its own citation
    assert.deepEqual(
      byEvent.sources.map((s: any) => s.attendee),
      ['Alex Chen', 'Priya Patel']
    );
    const alexSources = byEvent.sources[0].meetings;
    assert.ok(alexSources.some((m: any) => m.meetingId === 'm-roadmap'));
    assert.ok(alexSources.some((m: any) => m.meetingId === 'm-long'), 'all shared meetings are cited');
    assert.ok(alexSources.every((m: any) => m.title && m.date), 'every source carries title and date');
    // m-long has no summary, so the excerpt falls back to the transcript opening
    const allHands = alexSources.find((m: any) => m.meetingId === 'm-long');
    assert.ok(allHands.excerpt && allHands.excerpt.startsWith('line of discussion'));

    // Explicit title + attendees works without a calendar. p-nameless has a null
    // name — real stores contain these, and an unguarded compare here used to
    // throw and take the whole agenda down.
    const byTitle = await prepareMeetingHandler({ title: 'Ad hoc chat', attendees: ['Alex Chen'] });
    assert.ok(byTitle.agenda.includes('Alex Chen'));
    assert.equal(byTitle.sources.length, 1);

    const unknownAttendee = await prepareMeetingHandler({ title: 'Intro call', attendees: ['Nobody Known'] });
    assert.ok(!unknownAttendee.error, 'an attendee with no history is not an error');
    assert.deepEqual(unknownAttendee.sources, [{ attendee: 'Nobody Known', meetings: [] }]);

    const badEvent = await prepareMeetingHandler({ eventId: 'nope' });
    assert.ok(badEvent.error);

    const noArgs = await prepareMeetingHandler({});
    assert.ok(noArgs.error && noArgs.error.includes('personId'));

    setUpcomingEventsProvider(null);
  }

  // ── get_connection_status ───────────────────────────────────────────────────
  // Action execution is default-off, approval-aware, idempotent, and visible
  // through the same action-item detail the client started from.
  {
    const recommendation = buildActionExecutionRecommendation({
      title: 'Send launch follow-up email',
      description: 'Reply to the product group',
      source: { type: 'meeting', id: 'm-roadmap' },
      owner: 'Alex Chen',
      dueDate: '2026-07-28',
    });
    assert.deepEqual(recommendation.suggestedToolCategories, ['email']);
    assert.ok(recommendation.suggestedSteps[0].includes('linked meeting'));

    const disabled = await startActionExecutionHandler({
      actionItemId: 't-1',
      objective: 'Draft and send the billing-plan follow-up',
      plan: ['Draft the email', 'Send it after approval'],
      proposedTools: [{ name: 'gmail.send', purpose: 'Send the approved follow-up', target: 'team@example.com', dataShared: 'Action item summary' }],
      client: 'codex-test',
      approval: {
        confirmed: true,
        approvedBy: 'Test User',
        approvedAt: new Date().toISOString(),
        scope: 'Send the reviewed follow-up only to team@example.com',
        approvedTools: ['gmail.send'],
      },
      idempotencyKey: 'mcp-start-disabled-001',
    });
    assert.equal(disabled.code, 'WRITEBACK_DISABLED');

    setMcpWritebackEnabledProvider(() => true);
    const staleApproval = await startActionExecutionHandler({
      actionItemId: 't-1',
      objective: 'Draft and send the billing-plan follow-up',
      plan: ['Draft the email'],
      client: 'codex-test',
      approval: {
        confirmed: true,
        approvedBy: 'Test User',
        approvedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        scope: 'Draft the email',
      },
      idempotencyKey: 'mcp-start-stale-001',
    });
    assert.equal(staleApproval.code, 'APPROVAL_REQUIRED');

    const startArgs = {
      actionItemId: 't-1',
      objective: 'Draft and send the billing-plan follow-up',
      plan: ['Draft the email', 'Send it after approval'],
      proposedTools: [{ name: 'gmail.send', purpose: 'Send the approved follow-up', target: 'team@example.com', dataShared: 'Action item summary' }],
      client: 'codex-test',
      approval: {
        confirmed: true as const,
        approvedBy: 'Test User',
        approvedAt: new Date().toISOString(),
        scope: 'Send the reviewed follow-up only to team@example.com',
        approvedTools: ['gmail.send'],
      },
      idempotencyKey: 'mcp-start-enabled-001',
    };
    const started = await startActionExecutionHandler(startArgs);
    assert.ok(started.execution.executionId);
    assert.equal(started.execution.status, 'running');
    assert.equal(started.replayed, false);
    const startReplay = await startActionExecutionHandler(startArgs);
    assert.equal(startReplay.replayed, true);
    assert.equal(startReplay.execution.executionId, started.execution.executionId);

    const justStarted = await getActionItemHandler({ actionItemId: 't-1' });
    const prematureDone = await updateActionStatusHandler({
      actionItemId: 't-1',
      executionId: started.execution.executionId,
      status: 'completed',
      expectedUpdatedAt: justStarted.updatedAt,
      client: 'codex-test',
      idempotencyKey: 'mcp-status-premature-001',
    });
    assert.equal(prematureDone.code, 'COMPLETED_OUTCOME_REQUIRED');

    const outcomeArgs = {
      executionId: started.execution.executionId,
      result: 'completed' as const,
      summary: 'Sent the approved billing-plan follow-up to the product team.',
      artifacts: [{ type: 'email', label: 'Sent follow-up', url: 'https://mail.example/messages/123', externalId: '123' }],
      client: 'codex-test',
      idempotencyKey: 'mcp-outcome-001',
    };
    const outcome = await appendActionOutcomeHandler(outcomeArgs);
    assert.equal(outcome.execution.status, 'completed');
    assert.equal(outcome.outcome.artifacts[0].label, 'Sent follow-up');
    assert.equal((await appendActionOutcomeHandler(outcomeArgs)).replayed, true);

    const beforeStatus = await getActionItemHandler({ actionItemId: 't-1' });
    assert.equal(beforeStatus.executionHistory.length, 1);
    assert.equal(beforeStatus.executionHistory[0].outcomes.length, 1);
    assert.equal(beforeStatus.executionRecommendation.source, 'inwise-starter');
    const statusArgs = {
      actionItemId: 't-1',
      executionId: started.execution.executionId,
      status: 'completed' as const,
      note: 'The verified email artifact completes the action item.',
      expectedUpdatedAt: beforeStatus.updatedAt,
      client: 'codex-test',
      idempotencyKey: 'mcp-status-001',
    };
    const statusUpdate = await updateActionStatusHandler(statusArgs);
    assert.equal(statusUpdate.actionItem.status, 'completed');
    assert.equal(statusUpdate.replayed, false);
    // Retry carries the original expectedUpdatedAt but still succeeds because
    // idempotency is checked before optimistic-concurrency freshness.
    const statusReplay = await updateActionStatusHandler(statusArgs);
    assert.equal(statusReplay.replayed, true);

    const afterStatus = await getActionItemHandler({ actionItemId: 't-1' });
    assert.equal(afterStatus.status, 'completed');
    assert.equal(afterStatus.executionHistory[0].status, 'completed');
  }

  {
    const status = getConnectionStatusHandler();
    assert.equal(status.mode, 'local');
    assert.equal(status.access, 'read plus approved action writeback');
    assert.equal(status.actionWriteback.enabled, true);
    assert.ok(typeof status.version === 'string' && status.version.length > 0);
    assert.ok(status.server.startsWith('http://127.0.0.1:'));
    assert.deepEqual(status.capabilities, [...TOOL_NAMES], 'reports the surface this build serves');
    assert.ok(status.privacyNote.includes('get_transcript'), 'says where verbatim text can go');
    assert.equal(status.calendarConnected, false, 'no provider wired at this point in the run');

    setMcpWritebackEnabledProvider(() => false);
    assert.equal(getConnectionStatusHandler().access, 'read-only');
    assert.equal(getConnectionStatusHandler().actionWriteback.enabled, false);
    setMcpWritebackEnabledProvider(() => true);

    setUpcomingEventsProvider(() => [
      { id: 'e', title: 'x', startTime: new Date(Date.now() + 3600_000), attendees: [] },
    ]);
    assert.equal(getConnectionStatusHandler().calendarConnected, true);
    setUpcomingEventsProvider(null);
  }

  // ── HTTP end-to-end (Streamable HTTP on an ephemeral loopback port) ─────────
  {
    const started = await startMcpServer(0); // 0 = OS-assigned free port
    assert.equal(started.ok, true);
    assert.ok(started.port && started.port > 0);
    const port = started.port!;
    assert.deepEqual(getMcpStatus(), { running: true, port, error: null });

    // initialize handshake
    const init = await mcpPost(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } },
    });
    assert.equal(init.status, 200, init.body.slice(0, 300));
    assert.equal(JSON.parse(init.body).result.serverInfo.name, 'inwise-local');

    // tools/list exposes ten reads plus three explicitly annotated writes
    const list = await mcpPost(port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(list.status, 200, list.body.slice(0, 300));
    const tools = JSON.parse(list.body).result.tools;
    const names = tools.map((t: any) => t.name).sort();
    assert.deepEqual(names, [
      'append_action_outcome',
      'get_action_item',
      'get_connection_status',
      'get_meeting',
      'get_person',
      'get_transcript',
      'list_action_items',
      'list_people',
      'list_upcoming_meetings',
      'prepare_meeting',
      'search_meetings',
      'start_action_execution',
      'update_action_status',
    ]);
    assert.deepEqual(
      names,
      [...TOOL_NAMES].sort(),
      'the advertised list and the registered tools cannot drift apart'
    );
    const writeNames = new Set(['start_action_execution', 'append_action_outcome', 'update_action_status']);
    for (const t of tools) {
      if (writeNames.has(t.name)) {
        assert.equal(t.annotations?.readOnlyHint, false, `${t.name} is annotated as a write`);
        assert.equal(t.annotations?.idempotentHint, true, `${t.name} is retry-safe`);
        assert.equal(t.annotations?.openWorldHint, false, `${t.name} itself only writes to local Inwise`);
      } else {
        assert.equal(t.annotations?.readOnlyHint, true, `${t.name} is annotated read-only`);
      }
    }

    // tools/call round-trips against the fixture store
    const call = await mcpPost(port, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'search_meetings', arguments: { query: 'roadmap' } },
    });
    assert.equal(call.status, 200, call.body.slice(0, 300));
    const searchResult = parseToolResult(call.body);
    assert.equal(searchResult.results[0].meetingId, 'm-roadmap');

    const who = await mcpPost(port, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_connection_status', arguments: {} },
    });
    const whoResult = parseToolResult(who.body);
    assert.equal(whoResult.mode, 'local');

    const wireStart = await mcpPost(port, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'start_action_execution',
        arguments: {
          actionItemId: 't-owned',
          objective: 'Prepare the analytics spec outline',
          plan: ['Create a reviewable outline'],
          proposedTools: [],
          client: 'wire-test',
          approval: {
            confirmed: true,
            approvedBy: 'Test User',
            approvedAt: new Date().toISOString(),
            scope: 'Create a local outline only; do not publish it',
            approvedTools: [],
          },
          idempotencyKey: 'wire-start-owned-001',
        },
      },
    });
    assert.equal(wireStart.status, 200, wireStart.body.slice(0, 300));
    const wireStartResult = parseToolResult(wireStart.body);
    assert.equal(wireStartResult.execution.actionItemId, 't-owned');
    assert.equal(wireStartResult.execution.status, 'running');

    // Host-header rejection (DNS rebinding defense)
    const rebind = await mcpPost(port, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }, { Host: 'evil.com' });
    assert.equal(rebind.status, 403);

    // Non-POST rejected
    const get = await rawRequest(port, { method: 'GET', path: MCP_PATH });
    assert.equal(get.status, 405);

    // Wrong path rejected
    const notFound = await rawRequest(port, { method: 'POST', path: '/other' });
    assert.equal(notFound.status, 404);

    // Clean stop
    await stopMcpServer();
    assert.equal(getMcpStatus().running, false);

    // Port-in-use error is reported, not thrown
    const blocker = http.createServer(() => {});
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const blockedPort = (blocker.address() as any).port;
    const conflict = await startMcpServer(blockedPort);
    assert.equal(conflict.ok, false);
    assert.ok(conflict.error && conflict.error.includes('already in use'), conflict.error);
    assert.equal(getMcpStatus().running, false);
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }

  setMcpWritebackEnabledProvider(null);
  console.log('mcp-server: all tests passed');
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { run };
