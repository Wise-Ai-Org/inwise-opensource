/**
 * How sure Inwise is about one proposed Jira change (docs/JIRA_SAFETY.md).
 *
 * Pure and deterministic. The only model-supplied input is the extractor's
 * own certainty for the item (0..1); everything else is a signal we can
 * check: a spoken issue key, a named owner, an explicit due date, and how
 * strongly the item matches its target ticket (or, for a create, how weakly
 * it matches any existing ticket).
 *
 * There is no "undefined means ungated" path: every write gets a number.
 */

export type ConfidenceOperation = 'create' | 'update' | 'transition' | 'comment';

export interface ConfidenceSignals {
  operation: ConfidenceOperation;
  /** Extractor certainty 0..1. Missing or invalid -> DEFAULT_EXTRACTION_CERTAINTY. */
  extractionCertainty?: number | null;
  /** The issue key was said out loud (or written) in the source item. */
  keySpoken?: boolean;
  /** The item names an owner. */
  ownerIdentified?: boolean;
  /** The due date was stated, not inferred. */
  dueDateExplicit?: boolean;
  /**
   * 0..1. For update/transition/comment: strength of the match to the target
   * ticket (1 when the local task is already linked to that key). For create:
   * the best similarity to any existing ticket, so a likely duplicate lowers it.
   */
  matchStrength?: number | null;
}

export interface ConfidenceResult {
  confidence: number;
  parts: { extraction: number; owner: number; due: number; target: number };
}

export const DEFAULT_EXTRACTION_CERTAINTY = 0.5;

/** Clamp anything to 0..1; non-numbers become `fallback`. */
export function normalizeCertainty(value: unknown, fallback = DEFAULT_EXTRACTION_CERTAINTY): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  // Some models answer in percent.
  const scaled = n > 1 && n <= 100 ? n / 100 : n;
  return Math.max(0, Math.min(1, scaled));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * create:    0.55 * extraction + 0.20 * owner + 0.15 * due + 0.10 * (1 - bestMatch)
 * otherwise: 0.45 * extraction + 0.35 * target + 0.10 * owner + 0.10 * due
 *            where target = 1 when the key was spoken, else matchStrength.
 */
export function computeWriteConfidence(s: ConfidenceSignals): ConfidenceResult {
  const extraction = normalizeCertainty(s.extractionCertainty);
  const owner = s.ownerIdentified ? 1 : 0;
  const due = s.dueDateExplicit ? 1 : 0;
  const match = normalizeCertainty(s.matchStrength, 0);
  if (s.operation === 'create') {
    const novelty = s.keySpoken ? 0 : 1 - match;
    const confidence = 0.55 * extraction + 0.2 * owner + 0.15 * due + 0.1 * novelty;
    return { confidence: round2(Math.max(0, Math.min(1, confidence))), parts: { extraction, owner, due, target: novelty } };
  }
  const target = s.keySpoken ? 1 : match;
  const confidence = 0.45 * extraction + 0.35 * target + 0.1 * owner + 0.1 * due;
  return { confidence: round2(Math.max(0, Math.min(1, confidence))), parts: { extraction, owner, due, target } };
}

/** Issue keys like PILOT-42 mentioned in free text. */
export function spokenIssueKeys(text: string): string[] {
  const out = new Set<string>();
  const re = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || '')) !== null) out.add(m[1]);
  return Array.from(out);
}
