import * as assert from 'node:assert/strict';
import {
  classifySlackToken,
  getChannelHistory,
  getThreadReplies,
  postWiserNote,
  validateToken,
} from './slack-client';

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
  });
}

async function run(): Promise<void> {
  assert.equal(classifySlackToken('xoxp-user'), 'user');
  assert.equal(classifySlackToken('xoxb-bot'), 'bot');
  assert.equal(classifySlackToken('future-token'), 'unknown');

  {
    let called = false;
    const result = await validateToken('xoxb-bot', {
      fetchFn: async () => { called = true; return jsonResponse({ ok: true }); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.tokenType, 'bot');
    assert.match(result.error ?? '', /User OAuth Token/);
    assert.equal(called, false, 'bot token is rejected before a network call');
  }

  {
    const result = await validateToken('xoxp-user', {
      fetchFn: async (_url, init) => {
        assert.equal(init?.method, 'POST');
        return jsonResponse({ ok: true, team: 'Wise', user: 'Shrav' });
      },
    });
    assert.deepEqual(result, {
      ok: true,
      teamName: 'Wise',
      userName: 'Shrav',
      tokenType: 'user',
    });
  }

  {
    const urls: string[] = [];
    const pages = [
      jsonResponse({
        ok: true,
        messages: [{ ts: '3.0', user: 'U3', text: 'three' }, { ts: '2.0', user: 'U2', text: 'two' }],
        response_metadata: { next_cursor: 'page-2' },
      }),
      jsonResponse({
        ok: true,
        messages: [{ ts: '1.0', user: 'U1', text: 'one' }],
        response_metadata: { next_cursor: '' },
      }),
    ];
    const { messages } = await getChannelHistory('C1', '0.5', {
      token: 'xoxp-user',
      fetchFn: async (url) => {
        urls.push(String(url));
        return pages.shift()!;
      },
    });

    assert.deepEqual(messages.map((message) => message.ts), ['1.0', '2.0', '3.0']);
    assert.equal(urls.length, 2, 'every history page fetched');
    assert.match(urls[0], /limit=15/);
    assert.match(urls[0], /oldest=0.5/);
    assert.match(urls[1], /cursor=page-2/);
  }

  {
    const urls: string[] = [];
    const pages = [
      jsonResponse({
        ok: true,
        messages: [{ ts: '10.0', user: 'U1', text: 'parent' }],
        response_metadata: { next_cursor: 'replies-2' },
      }),
      jsonResponse({
        ok: true,
        messages: [{ ts: '11.0', user: 'U2', text: 'reply', thread_ts: '10.0' }],
        response_metadata: { next_cursor: '' },
      }),
    ];
    const replies = await getThreadReplies('C1', '10.0', {
      token: 'xoxp-user',
      fetchFn: async (url) => {
        urls.push(String(url));
        return pages.shift()!;
      },
    });

    assert.deepEqual(replies.map((message) => message.ts), ['10.0', '11.0']);
    assert.equal(urls.length, 2, 'every replies page fetched');
    assert.match(urls[1], /cursor=replies-2/);
  }

  {
    const waits: number[] = [];
    let attempt = 0;
    const { messages } = await getChannelHistory('C-rate-limit', undefined, {
      token: 'xoxp-user',
      delayFn: async (ms) => { waits.push(ms); },
      fetchFn: async () => {
        attempt++;
        if (attempt === 1) return jsonResponse({ ok: false }, 429, { 'Retry-After': '2' });
        return jsonResponse({ ok: true, messages: [{ ts: '20.0', text: 'recovered' }] });
      },
    });
    assert.deepEqual(waits, [2_000], 'Retry-After is honored before retrying');
    assert.deepEqual(messages.map((message) => message.ts), ['20.0']);
  }

  {
    let postedBody: any;
    await postWiserNote('C-write', 'A concise recap', {
      token: 'xoxp-user',
      writeChannels: ['C-write'],
      fetchFn: async (_url, init) => {
        postedBody = JSON.parse(String(init?.body));
        return jsonResponse({ ok: true });
      },
    });
    assert.equal(postedBody.channel, 'C-write');
    assert.match(postedBody.text, /\*Wiser Note\*/);
    assert.match(postedBody.text, /A concise recap/);

    await assert.rejects(
      () => postWiserNote('C-other', 'No', {
        token: 'xoxp-user',
        writeChannels: ['C-write'],
        fetchFn: async () => jsonResponse({ ok: true }),
      }),
      /not in the Slack write-channels list/,
    );
  }

  console.log('slack-client: all tests passed');
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { run };
