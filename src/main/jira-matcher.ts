/**
 * Local semantic matching engine for Jira stories.
 * Matches meeting action items / tasks against Jira stories using:
 *   1. Direct Jira key mention (e.g., "PLAT-201" in text)
 *   2. Keyword similarity (Jaccard coefficient)
 *   3. Title similarity
 *   4. LLM-powered semantic match (optional, uses user's API key)
 */

import { getConfig } from './config';
import { log } from './logger';
import { extractKeywords, simpleStem, jaccardSimilarity } from './text-similarity';

export interface MatchCandidate {
  jiraKey: string;
  title: string;
  similarity: number;
  matchFactors: { keyMention: number; keywords: number; title: number };
  jiraUrl: string;
}

export interface MatchResult {
  itemText: string;
  itemOwner?: string;
  candidates: MatchCandidate[];
  bestMatch: MatchCandidate | null;
  autoApproved: boolean;
}

// ── Text processing helpers ──────────────────────────────────────────────────
// Tokenizer/stemmer/Jaccard live in text-similarity.ts, shared with the
// task-mention dedup pipeline (US-003) — do not re-add local copies here.

// ── Matching engine ──────────────────────────────────────────────────────────

export function matchItemToStories(
  itemText: string,
  stories: { jiraKey: string; title: string; description: string; jiraUrl: string }[],
): MatchCandidate[] {
  const itemKeywords = new Set(extractKeywords(itemText).map(simpleStem));
  const jiraKeyPattern = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
  const mentionedKeys = new Set<string>();
  let match;
  while ((match = jiraKeyPattern.exec(itemText)) !== null) {
    mentionedKeys.add(match[1]);
  }

  const candidates: MatchCandidate[] = [];

  for (const story of stories) {
    let keyMention = 0;
    let keywordScore = 0;
    let titleScore = 0;

    // Factor 1: Direct key mention
    if (mentionedKeys.has(story.jiraKey)) {
      keyMention = 1.0;
    }

    // Factor 2: Keyword similarity (item vs story title + description)
    const storyText = `${story.title} ${story.description}`;
    const storyKeywords = new Set(extractKeywords(storyText).map(simpleStem));
    keywordScore = jaccardSimilarity(itemKeywords, storyKeywords);

    // Factor 3: Title similarity
    const itemTitleKeywords = new Set(extractKeywords(itemText).map(simpleStem));
    const storyTitleKeywords = new Set(extractKeywords(story.title).map(simpleStem));
    titleScore = jaccardSimilarity(itemTitleKeywords, storyTitleKeywords);

    // Weighted combination: key mention dominates
    const similarity = keyMention * 0.5 + keywordScore * 0.3 + titleScore * 0.2;

    if (similarity > 0.05) {
      candidates.push({
        jiraKey: story.jiraKey,
        title: story.title,
        similarity: Math.round(similarity * 100) / 100,
        matchFactors: {
          keyMention: Math.round(keyMention * 100) / 100,
          keywords: Math.round(keywordScore * 100) / 100,
          title: Math.round(titleScore * 100) / 100,
        },
        jiraUrl: story.jiraUrl,
      });
    }
  }

  return candidates.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
}

/**
 * Match multiple action items against Jira stories.
 * Returns a MatchResult for each item, with auto-approval for high confidence.
 */
export function matchAllItems(
  items: { text: string; owner?: string }[],
  stories: { jiraKey: string; title: string; description: string; jiraUrl: string }[],
): MatchResult[] {
  return items.map(item => {
    const candidates = matchItemToStories(item.text, stories);
    const bestMatch = candidates[0] || null;
    const autoApproved = bestMatch !== null && bestMatch.similarity >= 0.85;

    return {
      itemText: item.text,
      itemOwner: item.owner,
      candidates,
      bestMatch,
      autoApproved,
    };
  });
}

/**
 * LLM-powered semantic match — uses user's configured API key.
 * Sends items + story titles to Claude/OpenAI for deeper matching.
 * Falls back gracefully if no API key or if the call fails.
 */
export async function semanticMatch(
  items: { text: string; owner?: string }[],
  stories: { jiraKey: string; title: string }[],
): Promise<Record<string, string | null>> {
  const config = getConfig();
  if (!config.apiKey || items.length === 0 || stories.length === 0) return {};

  const storyList = stories.map(s => `${s.jiraKey}: ${s.title}`).join('\n');
  const itemList = items.map((item, i) => `${i + 1}. ${item.text}`).join('\n');

  const prompt = `Match these action items to Jira stories. Return JSON mapping item number to jiraKey (or null if no match).
Only match if genuinely the same work — not vaguely related topics.

Jira Stories:
${storyList}

Action Items:
${itemList}

Return: {"1": "PLAT-201", "2": null, "3": "PLAT-205"}`;

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
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) return {};
      const data = await res.json() as any;
      text = data.content?.[0]?.text || '{}';
    } else {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) return {};
      const data = await res.json() as any;
      text = data.choices?.[0]?.message?.content || '{}';
    }

    const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    return JSON.parse(stripped);
  } catch (e: any) {
    log('error', 'jira:semantic-match-failed', e.message);
    return {};
  }
}
