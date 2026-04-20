import { getConfig } from './config';

interface Insights {
  summary: string;
  actionItems: { text: string; owner?: string; dueDate?: string; priority?: string; isCommitment?: boolean }[];
  decisions: { text: string; rationale?: string }[];
  blockers: { text: string; severity?: string }[];
  contradictions: { text: string; previousDecision: string; previousMeetingTitle?: string; previousMeetingDate?: string }[];
}

const SYSTEM_PROMPT = `You are an expert meeting analyst. Given a meeting transcript, extract structured insights.

Classify every piece of information into exactly one of four categories: Summary, Action Item, Blocker, or Decision. Apply the routing and deduplication rules below strictly.

## ROUTING RULES (apply in this order)
1. Is it a committed, final choice the group agreed to? → Decision
2. Is it a task someone needs to do? → Action Item (even if no owner is named)
3. Is it an unresolved impediment still open when the meeting ends? → Blocker
4. Everything else → Summary

## DEDUPLICATION RULES — APPLY STRICTLY

CRITICAL: Each piece of information must appear in EXACTLY ONE category. No item should appear in two categories, even rephrased.

- A blocker that was assigned a fix → Action Item only. Do not also list as Blocker.
- A decision that results in someone needing to do something → Action Item only. The decision context goes in the action item's reasoning, NOT as a separate Decision. Only list as a separate Decision if the choice itself is the important thing to record AND no action item covers it.
- "Do X before Y" or "Start with X" → Action Item only (prioritization is implicit in the task). Do NOT also list as Decision.
- Context or rationale behind a decision → Summary only.
- A proposed idea not committed to → Summary only.
- A recurring status update with no new outcome → Summary only.

Self-check before returning: For each Decision, scan all Action Items — if any Action Item covers the same topic, DELETE the Decision. For each Blocker, check if a fix was assigned — if so, DELETE the Blocker.

If someone makes a personal promise or commitment (e.g., "I'll send the proposal by Friday"), include it as an action item with isCommitment: true. Commitments carry accountability weight.

Return a JSON object with this exact shape:
{
  "summary": "2-3 sentence summary of the meeting",
  "actionItems": [{ "text": "...", "owner": "name or null", "dueDate": "YYYY-MM-DD or null", "priority": "high|medium|low", "isCommitment": false }],
  "decisions": [{ "text": "...", "rationale": "... or null" }],
  "blockers": [{ "text": "...", "severity": "high|medium|low" }]
}
Return only valid JSON, no markdown fences.`;

const CONTRADICTION_PROMPT = `You are a meeting consistency analyst. You will receive:
1. A list of PREVIOUS DECISIONS from past meetings (with meeting title and date)
2. NEW DECISIONS from the current meeting

Your job: identify any new decision that contradicts, reverses, or significantly changes a previous decision.

Only flag genuine contradictions — not refinements, additions, or natural evolution. A decision to "increase budget to $50k" contradicts a prior "cap budget at $30k", but "add a new vendor" does not contradict "use vendor A" (it's additive).

Return a JSON array of contradictions (empty array if none):
[{ "text": "description of the contradiction", "previousDecision": "the original decision text that is contradicted", "previousMeetingTitle": "title of the meeting where the original decision was made", "previousMeetingDate": "date of that meeting" }]

Return only valid JSON, no markdown fences.`;

function parseInsights(text: string): Insights {
  // Strip markdown fences if present (```json ... ```)
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = JSON.parse(stripped);
  return {
    summary: parsed.summary || '',
    actionItems: parsed.actionItems || [],
    decisions: parsed.decisions || [],
    blockers: parsed.blockers || [],
    contradictions: parsed.contradictions || [],
  };
}

export async function extractInsights(transcript: string): Promise<Insights> {
  const config = getConfig();

  if (!config.apiKey) throw new Error('API key not configured');

  if (config.apiProvider === 'anthropic') {
    return extractWithClaude(transcript, config.apiKey);
  } else {
    return extractWithOpenAI(transcript, config.apiKey);
  }
}

async function extractWithClaude(transcript: string, apiKey: string): Promise<Insights> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Transcript:\n\n${transcript}` }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error: ${err}`);
  }

  const data = await res.json() as any;
  const text = data.content?.[0]?.text || '';
  return parseInsights(text);
}

// ── Contradiction detection ──────────────────────────────────────────────────

interface PastDecision {
  text: string;
  meetingTitle: string;
  meetingDate: string;
}

export async function detectContradictions(
  newDecisions: { text: string; rationale?: string }[],
  pastDecisions: PastDecision[],
): Promise<Insights['contradictions']> {
  if (newDecisions.length === 0 || pastDecisions.length === 0) return [];

  const config = getConfig();
  if (!config.apiKey) return [];

  const pastContext = pastDecisions.map(d =>
    `- "${d.text}" (from "${d.meetingTitle}", ${d.meetingDate})`
  ).join('\n');

  const newContext = newDecisions.map(d => `- "${d.text}"`).join('\n');

  const userMessage = `PREVIOUS DECISIONS:\n${pastContext}\n\nNEW DECISIONS:\n${newContext}`;

  try {
    let text: string;
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
          max_tokens: 1024,
          system: CONTRADICTION_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });
      if (!res.ok) throw new Error(`Claude API error: ${await res.text()}`);
      const data = await res.json() as any;
      text = data.content?.[0]?.text || '[]';
    } else {
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
            { role: 'system', content: CONTRADICTION_PROMPT },
            { role: 'user', content: userMessage },
          ],
        }),
      });
      if (!res.ok) throw new Error(`OpenAI API error: ${await res.text()}`);
      const data = await res.json() as any;
      text = data.choices?.[0]?.message?.content || '[]';
    }

    const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(stripped);
    // Handle both array and {contradictions: [...]} formats
    return Array.isArray(parsed) ? parsed : (parsed.contradictions || []);
  } catch {
    return [];
  }
}

// ── Meeting search ────────────────────────────────────────────────────────────

export async function searchMeetings(query: string, meetings: any[]): Promise<string> {
  const config = getConfig();
  if (!config.apiKey) throw new Error('API key not configured');

  const context = buildMeetingContext(meetings);

  if (config.apiProvider === 'anthropic') {
    return searchWithClaude(query, context, config.apiKey);
  } else {
    return searchWithOpenAI(query, context, config.apiKey);
  }
}

function buildMeetingContext(meetings: any[]): string {
  if (!meetings.length) return 'No meetings recorded yet.';
  return meetings.map((m: any) => {
    const date = new Date(m.date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    const lines: string[] = [`## "${m.title}" — ${date}`];
    if (m.insights?.summary) lines.push(`Summary: ${m.insights.summary}`);
    if (m.insights?.actionItems?.length) {
      lines.push(`Action items: ${m.insights.actionItems.map((a: any) => `${a.text}${a.owner ? ` (${a.owner})` : ''}`).join(' | ')}`);
    }
    if (m.insights?.decisions?.length) {
      lines.push(`Decisions: ${m.insights.decisions.map((d: any) => d.text).join(' | ')}`);
    }
    if (m.insights?.blockers?.length) {
      lines.push(`Blockers: ${m.insights.blockers.map((b: any) => b.text).join(' | ')}`);
    }
    if (m.insights?.commitments?.length) {
      lines.push(`Commitments: ${m.insights.commitments.map((c: any) => `${c.who}: ${c.text}`).join(' | ')}`);
    }
    if (m.insights?.contradictions?.length) {
      lines.push(`Contradictions flagged: ${m.insights.contradictions.map((c: any) => c.text).join(' | ')}`);
    }
    if (m.transcript) {
      lines.push(`Transcript: ${m.transcript.slice(0, 2000)}${m.transcript.length > 2000 ? '…' : ''}`);
    }
    return lines.join('\n');
  }).join('\n\n---\n\n');
}

async function searchWithClaude(query: string, context: string, apiKey: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: 'You are a meeting intelligence assistant. Answer the user\'s question based on their meeting history. Be specific — cite meeting titles and dates where relevant. If the answer is not in the meeting data, say so clearly.',
      messages: [{ role: 'user', content: `Meeting history:\n\n${context}\n\n---\n\nQuestion: ${query}` }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API error: ${await res.text()}`);
  const data = await res.json() as any;
  return data.content?.[0]?.text || '';
}

async function searchWithOpenAI(query: string, context: string, apiKey: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a meeting intelligence assistant. Answer the user\'s question based on their meeting history. Be specific — cite meeting titles and dates where relevant. If the answer is not in the meeting data, say so clearly.' },
        { role: 'user', content: `Meeting history:\n\n${context}\n\n---\n\nQuestion: ${query}` },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error: ${err}`);
  }

  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

// ── Agenda generation ────────────────────────────────────────────────────────

const AGENDA_SYSTEM_PROMPT = `You are a meeting preparation assistant. Given context about a person (or attendees), their meeting history, open action items, commitments, and relationship dynamics, suggest a focused agenda for the next meeting.

Return a JSON object with this exact shape:
{"agenda":["item1","item2","item3","item4","item5"]}

Guidelines:
- 4-6 items, each a short actionable sentence (under 15 words)
- Prioritize: overdue commitments → open action items → follow-ups from recent meetings → forward-looking topics
- If there are open tasks or commitments, always include at least one item to review them
- Be specific — reference actual topics, decisions, and names from the context, not generic placeholders
- If very little context is available, fall back to sensible defaults for the meeting type

Return only valid JSON, no markdown fences.`;

export async function generateAgenda(context: string): Promise<string[]> {
  const config = getConfig();
  if (!config.apiKey) return [];

  try {
    let text: string;
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
          system: AGENDA_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: context }],
        }),
      });
      if (!res.ok) throw new Error(`Claude API error: ${await res.text()}`);
      const data = await res.json() as any;
      text = data.content?.[0]?.text || '';
    } else {
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
            { role: 'system', content: AGENDA_SYSTEM_PROMPT },
            { role: 'user', content: context },
          ],
        }),
      });
      if (!res.ok) throw new Error(`OpenAI API error: ${await res.text()}`);
      const data = await res.json() as any;
      text = data.choices?.[0]?.message?.content || '';
    }

    const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(stripped);
    return parsed.agenda || [];
  } catch {
    return [];
  }
}

// ── Task field suggestion ────────────────────────────────────────────────────

const TASK_FIELDS_SYSTEM_PROMPT = `You are a task planning assistant. Given a task title and context (recent meetings, existing tasks, people), suggest appropriate field values for the task.

Return a JSON object with this exact shape:
{
  "priority": { "value": "low|medium|high|critical", "confidence": 0.0-1.0, "source": "brief reason" },
  "complexity": { "value": "S|M|L|XL", "confidence": 0.0-1.0, "source": "brief reason" },
  "dueDate": { "value": "YYYY-MM-DD or null", "confidence": 0.0-1.0, "source": "brief reason" },
  "assignee": { "value": "person name or null", "confidence": 0.0-1.0, "source": "brief reason" }
}

Guidelines:
- Priority: critical = blocking others / urgent deadline, high = important this week, medium = normal, low = nice-to-have
- Complexity: S = under 1 hour, M = a few hours, L = a day or more, XL = multi-day effort
- Due date: only suggest if there's a clear deadline or timing clue in the context; otherwise null
- Assignee: only suggest if context makes it clear who should own this; otherwise null
- Confidence: 0.9+ = very confident (explicit evidence), 0.6-0.8 = reasonable inference, below 0.5 = guess
- Source: cite the specific meeting, task, or context that informed your suggestion (keep it under 15 words)

Return only valid JSON, no markdown fences.`;

export interface TaskFieldSuggestions {
  suggestions: {
    priority: { value: string; confidence: number; source: string };
    complexity: { value: string; confidence: number; source: string };
    dueDate: { value: string | null; confidence: number; source: string };
    assignee: { value: string | null; confidence: number; source: string };
  };
  meta: { hasData: boolean };
}

export async function suggestTaskFields(
  title: string,
  contextText: string,
  hasData: boolean,
): Promise<TaskFieldSuggestions> {
  const config = getConfig();
  if (!config.apiKey) throw new Error('API key not configured');

  const userMessage = `Task title: "${title}"\n\nContext:\n${contextText}`;

  let text: string;
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
        system: TASK_FIELDS_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    if (!res.ok) throw new Error(`Claude API error: ${await res.text()}`);
    const data = await res.json() as any;
    text = data.content?.[0]?.text || '';
  } else {
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
          { role: 'system', content: TASK_FIELDS_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI API error: ${await res.text()}`);
    const data = await res.json() as any;
    text = data.choices?.[0]?.message?.content || '';
  }

  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = JSON.parse(stripped);
  return {
    suggestions: {
      priority: parsed.priority || { value: 'medium', confidence: 0.3, source: 'default' },
      complexity: parsed.complexity || { value: 'M', confidence: 0.3, source: 'default' },
      dueDate: parsed.dueDate || { value: null, confidence: 0, source: 'no data' },
      assignee: parsed.assignee || { value: null, confidence: 0, source: 'no data' },
    },
    meta: { hasData },
  };
}

async function extractWithOpenAI(transcript: string, apiKey: string): Promise<Insights> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Transcript:\n\n${transcript}` },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error: ${err}`);
  }

  const data = await res.json() as any;
  const text = data.choices?.[0]?.message?.content || '';
  return parseInsights(text);
}
