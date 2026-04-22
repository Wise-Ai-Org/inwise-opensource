import { getConfig } from './config';

export interface OpenTaskForInference {
  _id: string;
  title: string;
  description?: string;
}

export type LlmCaller = (systemPrompt: string, userMessage: string) => Promise<string>;

const SYSTEM_PROMPT = `You are a careful meeting analyst identifying tasks that a meeting transcript strongly implies are already completed.

You will receive:
1. A meeting transcript
2. A list of open tasks, each with an id and title

Your job: return the ids of tasks whose completion is strongly implied by the transcript. Prefer false negatives over false positives — only flag a task when a participant explicitly states it is done, shipped, merged, delivered, deployed, or otherwise finished. Do NOT flag tasks that are merely discussed, planned, in-progress, or partially done.

Rules:
- Return ONLY high-confidence matches. If in doubt, leave the task out.
- A task being mentioned is not enough. A participant must clearly state the task is completed (past tense, definitive).
- Ignore hedged language like "almost done", "working on it", "should be finished soon".
- Match semantically, not literally — "shipped the login redirect" can match a task titled "Fix login flow".

Return a JSON object with this exact shape:
{"completedTaskIds": ["id1", "id2"]}

If no tasks are strongly implied as completed, return {"completedTaskIds": []}.

Return only valid JSON, no markdown fences.`;

export function buildUserMessage(transcript: string, openTasks: OpenTaskForInference[]): string {
  const taskLines = openTasks.map((t) => `- id="${t._id}" title="${t.title}"`).join('\n');
  return `TRANSCRIPT:\n${transcript}\n\n---\n\nOPEN TASKS:\n${taskLines}`;
}

export function parseInferenceResponse(text: string, validTaskIds: Set<string>): string[] {
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed: any;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return [];
  }
  const ids: string[] = Array.isArray(parsed?.completedTaskIds) ? parsed.completedTaskIds : [];
  // Only accept ids the model was actually given — never trust arbitrary strings.
  return ids.filter((id) => typeof id === 'string' && validTaskIds.has(id));
}

export async function inferCompletedTaskIdsWith(
  transcript: string,
  openTasks: OpenTaskForInference[],
  llm: LlmCaller,
): Promise<string[]> {
  if (!transcript || !transcript.trim()) return [];
  if (!openTasks.length) return [];
  const validIds = new Set(openTasks.map((t) => t._id));
  const userMessage = buildUserMessage(transcript, openTasks);
  try {
    const text = await llm(SYSTEM_PROMPT, userMessage);
    return parseInferenceResponse(text, validIds);
  } catch {
    return [];
  }
}

async function defaultLlmCaller(systemPrompt: string, userMessage: string): Promise<string> {
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
        max_tokens: 1024,
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

export async function inferCompletedTaskIds(
  transcript: string,
  openTasks: OpenTaskForInference[],
): Promise<string[]> {
  return inferCompletedTaskIdsWith(transcript, openTasks, defaultLlmCaller);
}
