/**
 * Status-change history for the prep card's "moved since you last met".
 * Bounded: only the handful of candidate issues (ollie-jira changelogCandidates)
 * are fetched, and each result is cached per issue key and its `updated`
 * timestamp, so an unchanged issue never costs a second call.
 */
import { fetchIssueStatusChanges, type StatusChange } from './jira-client';

const cache = new Map<string, { updatedAt: string; changes: StatusChange[] }>();
const MAX_CACHE = 300;

export function __clearChangelogCacheForTests(): void {
  cache.clear();
}

export async function statusChangesForIssues(
  issues: { key: string; updatedAt: string }[],
  fetcher: (key: string) => Promise<StatusChange[]> = fetchIssueStatusChanges,
): Promise<Map<string, StatusChange[] | null>> {
  const out = new Map<string, StatusChange[] | null>();
  for (const i of issues) {
    const hit = cache.get(i.key);
    if (hit && hit.updatedAt === i.updatedAt) { out.set(i.key, hit.changes); continue; }
    try {
      const changes = await fetcher(i.key);
      cache.set(i.key, { updatedAt: i.updatedAt, changes });
      if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
      out.set(i.key, changes);
    } catch {
      out.set(i.key, null); // caller falls back to the status-category heuristic
    }
  }
  return out;
}
