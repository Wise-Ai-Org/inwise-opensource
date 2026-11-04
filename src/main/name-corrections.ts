/**
 * Name corrections: when the user fixes a misheard name ("Satya" -> "Sacha"),
 * the fix is applied across one meeting and remembered for future meetings.
 * Pure helpers, no Electron or persistence, so they are directly testable.
 */

export type NameCorrections = Record<string, string>;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace whole-word occurrences of `from` with `to`, ignoring case. */
export function replaceName(text: string, from: string, to: string): string {
  const source = String(from || '').trim();
  if (!text || !source || source === to) return text;
  // Unicode-aware word boundaries so "Satya" does not match inside "Satyam".
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(source)}(?![\\p{L}\\p{N}_])`, 'giu');
  return text.replace(pattern, to);
}

/** Apply every remembered correction to a piece of text. */
export function applyNameCorrections(text: string, corrections: NameCorrections | null | undefined): string {
  if (!text || !corrections) return text;
  let out = text;
  for (const [from, to] of Object.entries(corrections)) out = replaceName(out, from, to);
  return out;
}

/**
 * Apply a text transform to every string inside a value (objects and arrays
 * are copied, other values returned as-is). Keys like ids and dates are left
 * alone because names never appear in them; the regex only matches whole words.
 */
export function mapStrings<T>(value: T, fn: (text: string) => string, skipKeys: Set<string> = DEFAULT_SKIP_KEYS): T {
  if (typeof value === 'string') return fn(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn, skipKeys)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = skipKeys.has(k) ? v : mapStrings(v, fn, skipKeys);
    }
    return out as T;
  }
  return value;
}

const DEFAULT_SKIP_KEYS = new Set(['_id', 'id', 'taskId', 'issueKey', 'jiraKey', 'blockedItemId', 'relatedItemId', 'dueDate', 'createdAt', 'updatedAt', 'extractedAt']);

/** Add one correction, collapsing chains (A->B then B->C makes A->C) and dropping self-maps. */
export function addCorrection(current: NameCorrections, from: string, to: string): NameCorrections {
  const source = String(from || '').trim();
  const target = String(to || '').trim();
  if (!source || !target || source.toLowerCase() === target.toLowerCase()) return { ...current };
  const next: NameCorrections = {};
  for (const [k, v] of Object.entries(current)) {
    if (k.toLowerCase() === source.toLowerCase()) continue;
    if (k.toLowerCase() === target.toLowerCase()) continue; // the new name is correct now
    next[k] = v.toLowerCase() === source.toLowerCase() ? target : v;
  }
  next[source] = target;
  return next;
}
