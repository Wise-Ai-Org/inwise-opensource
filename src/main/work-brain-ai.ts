import { getConfig } from './config';
import { ORG_CONTEXT_DRAFT_PROMPT, parseOrgContextDrafts } from './org-context-draft';

export async function draftOrgContext(meeting: any, projects: { id: string; name: string; description?: string }[]) {
  const config = getConfig();
  if (!config.apiKey) throw new Error('Add your AI provider key in Controls, or write an org summary manually.');
  const source = String(meeting.transcript || JSON.stringify({ summary:meeting.summary, decisions:meeting.decisions, actionItems:meeting.actionItems, blockers:meeting.blockers })).slice(0,24000);
  if (!source.trim()) throw new Error('This meeting has no context to draft from yet.');
  const content = JSON.stringify({ projects:projects.slice(0,100), privateSource:source });
  const anthropic = config.apiProvider === 'anthropic';
  const response = await fetch(anthropic?'https://api.anthropic.com/v1/messages':'https://api.openai.com/v1/chat/completions', {
    method:'POST', signal:AbortSignal.timeout(60000),
    headers:anthropic?{'x-api-key':config.apiKey,'anthropic-version':'2023-06-01','Content-Type':'application/json'}:{Authorization:`Bearer ${config.apiKey}`,'Content-Type':'application/json'},
    body:JSON.stringify(anthropic?{model:'claude-haiku-4-5-20251001',max_tokens:3000,system:ORG_CONTEXT_DRAFT_PROMPT,messages:[{role:'user',content}]}:{model:'gpt-4o-mini',response_format:{type:'json_object'},messages:[{role:'system',content:ORG_CONTEXT_DRAFT_PROMPT},{role:'user',content}]})
  });
  if (!response.ok) throw new Error('Your AI provider could not create an org draft. Check the provider connection or write it manually.');
  const data:any = await response.json();
  const text = anthropic?(data.content||[]).filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n'):data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Your AI provider returned no draft. Try again or write it manually.');
  return parseOrgContextDrafts(text, projects, source);
}
