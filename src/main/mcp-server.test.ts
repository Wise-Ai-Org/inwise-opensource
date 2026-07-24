import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import Datastore from '@seald-io/nedb';
import { __setMeetingsDbForTests, __setTasksDbForTests } from './database';
import {
  MCP_PATH,
  TRANSCRIPT_CHUNK_CHARS,
  extractSnippet,
  getMcpStatus,
  getMeetingHandler,
  isAllowedHostHeader,
  isLoopbackAddress,
  listActionItemsHandler,
  searchMeetingsHandler,
  startMcpServer,
  stopMcpServer,
  whoamiHandler,
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
  await meetingsDb.loadDatabaseAsync();
  await tasksDb.loadDatabaseAsync();
  __setMeetingsDbForTests(meetingsDb);
  __setTasksDbForTests(tasksDb);

  const longTranscript = 'line of discussion. '.repeat(4000); // 80,000 chars > one chunk

  await meetingsDb.insertAsync([
    {
      _id: 'm-roadmap',
      title: 'Q3 Roadmap Review',
      date: '2026-07-21T10:00:00.000Z',
      duration: 1800,
      attendees: ['Alex Chen', 'Priya Patel'],
      transcript: 'Alex: We agreed to ship the billing revamp first. Priya: Yes, billing before analytics.',
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

  // ── get_meeting ─────────────────────────────────────────────────────────────
  {
    const full = await getMeetingHandler({ meetingId: 'm-roadmap' });
    assert.equal(full.title, 'Q3 Roadmap Review');
    assert.deepEqual(full.attendees, ['Alex Chen', 'Priya Patel']);
    assert.equal(full.insights.summary, 'Team prioritized the billing revamp over analytics for Q3.');
    assert.equal(full.insights.decisions.length, 1);
    assert.equal(full.transcript.nextOffset, null, 'short transcript fits in one chunk');
    assert.equal(full.transcript.chunk.length, full.transcript.totalChars);

    // Long transcript pages in <=48KB chunks
    const page1 = await getMeetingHandler({ meetingId: 'm-long' });
    assert.equal(page1.transcript.chunk.length, TRANSCRIPT_CHUNK_CHARS);
    assert.equal(page1.transcript.nextOffset, TRANSCRIPT_CHUNK_CHARS);
    assert.equal(page1.transcript.totalChars, longTranscript.length);

    const page2 = await getMeetingHandler({ meetingId: 'm-long', transcriptOffset: page1.transcript.nextOffset });
    assert.equal(page2.transcript.chunk.length, longTranscript.length - TRANSCRIPT_CHUNK_CHARS);
    assert.equal(page2.transcript.nextOffset, null);
    assert.equal(page1.transcript.chunk + page2.transcript.chunk, longTranscript, 'chunks reassemble losslessly');

    // Meeting without transcript
    const noTranscript = await getMeetingHandler({ meetingId: 'm-empty' });
    assert.equal(noTranscript.transcript.totalChars, 0);
    assert.equal(noTranscript.insights, null);

    // Unknown id
    const missing = await getMeetingHandler({ meetingId: 'nope' });
    assert.ok(missing.error);
  }

  // ── list_action_items ───────────────────────────────────────────────────────
  {
    const all = await listActionItemsHandler({});
    assert.equal(all.total, 3, 'archived tasks excluded, snoozed included');
    assert.ok(all.actionItems.some((t: any) => t.taskId === 't-3' && t.snoozed === true));

    const todo = await listActionItemsHandler({ status: 'todo' });
    assert.equal(todo.total, 2);
    assert.ok(todo.actionItems.every((t: any) => t.status === 'todo'));

    const byMeeting = await listActionItemsHandler({ meetingId: 'm-roadmap' });
    assert.equal(byMeeting.total, 1);
    assert.equal(byMeeting.actionItems[0].taskId, 't-1');
    assert.equal(byMeeting.actionItems[0].sourceMeetingId, 'm-roadmap');

    const limited = await listActionItemsHandler({ limit: 1 });
    assert.equal(limited.actionItems.length, 1);
    assert.equal(limited.total, 3, 'total reflects all matches even when page is capped');
  }

  // ── whoami ──────────────────────────────────────────────────────────────────
  {
    const who = whoamiHandler();
    assert.equal(who.mode, 'local');
    assert.equal(who.access, 'read-only');
    assert.ok(typeof who.version === 'string' && who.version.length > 0);
    assert.ok(who.server.startsWith('http://127.0.0.1:'));
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

    // tools/list exposes the four read-only tools
    const list = await mcpPost(port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(list.status, 200, list.body.slice(0, 300));
    const tools = JSON.parse(list.body).result.tools;
    const names = tools.map((t: any) => t.name).sort();
    assert.deepEqual(names, ['get_meeting', 'list_action_items', 'search_meetings', 'whoami']);
    for (const t of tools) {
      assert.equal(t.annotations?.readOnlyHint, true, `${t.name} is annotated read-only`);
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
      params: { name: 'whoami', arguments: {} },
    });
    const whoResult = parseToolResult(who.body);
    assert.equal(whoResult.mode, 'local');

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

  console.log('mcp-server: all tests passed');
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { run };
