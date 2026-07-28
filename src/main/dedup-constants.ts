/**
 * Task-mention dedup thresholds (task-dedup PRD).
 *
 * All tunables in one place. OSS has no env plumbing — named constants are the
 * contract. Tune from match-decisions.db data, never automatically (US-011).
 */

/** LLM confidence (0-100) at/above which a same_task verdict merges without asking. */
export const AUTO_MERGE_THRESHOLD = 90;

/** LLM confidence (0-100) at/above which (but below AUTO_MERGE) we ask the user. */
export const ASK_THRESHOLD = 60;

/** Jaccard retrieval floor — prunes obvious non-matches before the LLM call. */
export const RETRIEVAL_FLOOR = 0.2;

/** Max candidates sent to the LLM classifier. */
export const RETRIEVAL_TOP_K = 5;

/** Done tasks completed within this window are still retrieved, flagged wasDone (US-008). */
export const DONE_LOOKBACK_DAYS = 14;

/** Open tasks with no activity for longer than this are out of candidate scope (US-012). */
export const STALE_CANDIDATE_DAYS = 90;

/** Mention-count window for the priority nudge (US-014). */
export const REPETITION_NUDGE_WINDOW_DAYS = 7;

/** Mentions within the window that trigger the "Raised N× this week" chip (US-014). */
export const REPETITION_NUDGE_COUNT = 3;

/**
 * When LLM classification fails for any reason, fall back to the legacy
 * Jaccard-only behavior: merge at/above this similarity, else create (FR-12).
 */
export const FALLBACK_JACCARD_THRESHOLD = 0.65;

/**
 * Rank boost added per matched context signal (attendee overlap, same
 * recurring series) when ordering retrieval candidates (US-012). Boosts affect
 * ranking only — the RETRIEVAL_FLOOR applies to the raw Jaccard score.
 */
export const CONTEXT_SIGNAL_BOOST = 0.15;

/** Versioned classifier prompt id (mirrors the web PROMPT_VERSION convention). */
export const MATCH_PROMPT_VERSION = 'oss-task-match-v1';
