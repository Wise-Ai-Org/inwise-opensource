import { getConfig } from './config';

interface Insights {
  summary: string;
  actionItems: { text: string; owner?: string; dueDate?: string; priority?: string }[];
  decisions: { text: string; rationale?: string }[];
  blockers: { text: string; severity?: string }[];
  people: { name: string; email?: string; role?: string; company?: string }[];
}

const SYSTEM_PROMPT = `You are an expert meeting analyst. Given a meeting transcript, extract structured insights.
Return a JSON object with this exact shape:
{
  "summary": "2-3 sentence summary of the meeting",
  "actionItems": [{ "text": "...", "owner": "name or null", "dueDate": "YYYY-MM-DD or null", "priority": "high|medium|low" }],
  "decisions": [{ "text": "...", "rationale": "... or null" }],
  "blockers": [{ "text": "...", "severity": "high|medium|low" }],
  "people": [{ "name": "...", "email": null, "role": null, "company": null }]
}
Return only valid JSON, no markdown fences.`;

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
  return JSON.parse(text) as Insights;
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
  return JSON.parse(text) as Insights;
}
