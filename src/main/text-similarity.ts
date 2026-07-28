/**
 * Shared lexical similarity helpers.
 *
 * Extracted from jira-matcher.ts (US-003, task-dedup PRD) so the Jira story
 * matcher and the task-mention dedup pipeline score text with ONE scorer
 * instead of two drifting copies. Pure functions — no I/O, no Electron.
 */

export const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'must', 'this', 'that',
  'these', 'those', 'it', 'its', 'we', 'they', 'them', 'their', 'our',
  'not', 'no', 'up', 'out', 'if', 'about', 'into', 'from', 'as', 'so',
]);

export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

export function simpleStem(word: string): string {
  // Very basic stemmer — handles common suffixes
  return word
    .replace(/ing$/, '')
    .replace(/tion$/, 't')
    .replace(/sion$/, 's')
    .replace(/ment$/, '')
    .replace(/ness$/, '')
    .replace(/able$/, '')
    .replace(/ible$/, '')
    .replace(/ful$/, '')
    .replace(/less$/, '')
    .replace(/ous$/, '')
    .replace(/ive$/, '')
    .replace(/ed$/, '')
    .replace(/er$/, '')
    .replace(/ly$/, '')
    .replace(/es$/, '')
    .replace(/s$/, '');
}

export function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Stemmed-keyword set for a blob of text. */
export function keywordSet(text: string): Set<string> {
  return new Set(extractKeywords(text || '').map(simpleStem));
}

/** Jaccard similarity of the stemmed keyword sets of two text blobs (0..1). */
export function textSimilarity(a: string, b: string): number {
  return jaccardSimilarity(keywordSet(a), keywordSet(b));
}
