/**
 * Fuzzy person-name matching — ported from the Inwise cloud data layer
 * (appwise-functions/shared/fuzzyNameScore.js) so the desktop app resolves
 * "J. Patel" / "Jordan Patel" / "Bob" / "Robert" to the same person.
 * Pure and synchronous; no I/O.
 */

// Common English given-name nicknames mapped to their canonical form.
const NICKNAME_MAP: Record<string, string> = {
  bob: 'robert', bobby: 'robert', rob: 'robert', robbie: 'robert',
  bill: 'william', billy: 'william', will: 'william', willy: 'william',
  jim: 'james', jimmy: 'james',
  tom: 'thomas', tommy: 'thomas',
  mike: 'michael', mikey: 'michael',
  dave: 'david',
  joe: 'joseph', joey: 'joseph',
  steve: 'stephen', stevie: 'stephen',
  dan: 'daniel', danny: 'daniel',
  matt: 'matthew',
  chris: 'christopher',
  beth: 'elizabeth', betty: 'elizabeth', liz: 'elizabeth', libby: 'elizabeth',
  kate: 'katherine', katie: 'katherine', kathy: 'katherine', cathy: 'catherine',
  sue: 'susan', susie: 'susan',
  jen: 'jennifer', jenny: 'jennifer',
  jan: 'jane',
  peg: 'margaret', peggy: 'margaret', maggie: 'margaret', meg: 'margaret',
  tony: 'anthony',
  jeff: 'jeffrey',
  rick: 'richard', dick: 'richard', rich: 'richard',
  ron: 'ronald', ronnie: 'ronald',
  sam: 'samuel',
  ed: 'edward', eddie: 'edward', ted: 'edward',
  ben: 'benjamin', benny: 'benjamin',
  andy: 'andrew',
  nick: 'nicholas',
  fred: 'frederick', freddie: 'frederick',
  charlie: 'charles', chuck: 'charles',
  larry: 'lawrence',
  jerry: 'gerald',
  ken: 'kenneth', kenny: 'kenneth',
  art: 'arthur',
  hank: 'henry',
  jack: 'john', johnny: 'john',
  alex: 'alexander',
  pat: 'patricia', patty: 'patricia',
  nate: 'nathaniel', nathan: 'nathaniel',
  brad: 'bradley',
  tim: 'timothy',
  phil: 'philip',
  vince: 'vincent',
  al: 'albert',
};

/**
 * Normalise a raw name string for comparison: strip diacritics, lowercase,
 * remove titles/suffixes, punctuation → space, collapse whitespace.
 */
export function normalizeNameStr(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^(dr|mr|mrs|ms|miss|prof|rev|sr|jr)\.?\s+/g, '')
    .replace(/,?\s+(jr|sr|ii|iii|iv|v|esq|md|phd)\.?$/g, '')
    .replace(/[.',"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function expandNicknames(tokens: string[]): string[] {
  return tokens.map(t => NICKNAME_MAP[t] || t);
}

/** Classic Wagner-Fischer Levenshtein edit distance (O(m*n) time, O(n) space). */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = Array.from({ length: n + 1 }, (_, i) => i);
  const curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

/**
 * Token-level alignment score with initial-character awareness:
 * exact → 1.0; single-char initial vs full token → 0.85; Levenshtein
 * similarity ≥ 0.65 → sim * 0.9; else unmatched. Normalised by the longer
 * token count so extra tokens penalise.
 */
function alignedTokenScore(tokA: string[], tokB: string[]): { score: number; usedPrefix: boolean } {
  const longer = tokA.length >= tokB.length ? tokA : tokB;
  const shorter = tokA.length < tokB.length ? tokA : tokB;
  const used = new Array(longer.length).fill(false);
  let total = 0;
  let usedPrefix = false;

  for (const st of shorter) {
    let best = 0;
    let bestIdx = -1;
    let bestWasPrefix = false;
    for (let i = 0; i < longer.length; i++) {
      if (used[i]) continue;
      const lt = longer[i];
      let s: number;
      let wasPrefix = false;
      if (st === lt) {
        s = 1.0;
      } else if (st.length === 1 && lt.startsWith(st)) {
        s = 0.85;
      } else if (lt.length === 1 && st.startsWith(lt)) {
        s = 0.85;
      } else if ((st.length >= 3 && lt.startsWith(st)) || (lt.length >= 3 && st.startsWith(lt))) {
        // Desktop extension over the cloud port: short-form prefix nicknames
        // ("Zee" → "Zeeshan") that the English nickname table can't know.
        // Prefix-derived matches are flagged so callers keep them in the
        // human-triage band — never auto-merge on a prefix alone.
        s = 0.8;
        wasPrefix = true;
      } else {
        const lev = levenshtein(st, lt);
        const sim = 1 - lev / Math.max(st.length, lt.length);
        s = sim >= 0.65 ? sim * 0.9 : 0;
      }
      if (s > best) { best = s; bestIdx = i; bestWasPrefix = wasPrefix; }
    }
    if (bestIdx >= 0) {
      total += best;
      used[bestIdx] = true;
      if (bestWasPrefix) usedPrefix = true;
    }
  }

  return { score: total / Math.max(tokA.length, tokB.length), usedPrefix };
}

/**
 * Compare two person names → similarity in [0, 1].
 * 1.0 = identical after normalisation/nickname expansion; high = same person
 * with minor variation (initials, typo, nickname); low = different people.
 */
export function fuzzyNameScore(nameA: string | null | undefined, nameB: string | null | undefined): number {
  const normA = normalizeNameStr(nameA);
  const normB = normalizeNameStr(nameB);

  if (!normA || !normB) return 0.0;
  if (normA === normB) return 1.0;

  const tokA = expandNicknames(normA.split(' '));
  const tokB = expandNicknames(normB.split(' '));

  if (tokA.join(' ') === tokB.join(' ')) return 1.0;

  const aligned = alignedTokenScore(tokA, tokB);

  const expandedA = tokA.join(' ');
  const expandedB = tokB.join(' ');
  const levSc = 1 - levenshtein(expandedA, expandedB) / Math.max(expandedA.length, expandedB.length);

  let score = Math.max(aligned.score, levSc);

  // Desktop extension over the cloud port: a single-token name ("Zee", "Bob")
  // compared against a full name is scored against the FIRST name token and
  // damped ×0.9 — strong first-name matches land in the review band (or, for
  // nickname-table hits, the auto band) instead of being drowned by the
  // missing surname.
  if (tokA.length === 1 || tokB.length === 1) {
    const single = tokA.length === 1 ? tokA[0] : tokB[0];
    const first = tokA.length === 1 ? tokB[0] : tokA[0];
    const firstAligned = alignedTokenScore([single], [first]);
    score = Math.max(score, firstAligned.score * 0.9);
  }

  // A pair whose similarity leans on a prefix match never auto-merges — cap it
  // just below SAME_PERSON_THRESHOLD so it surfaces as a triage card instead.
  if (aligned.usedPrefix && score >= SAME_PERSON_THRESHOLD) {
    score = SAME_PERSON_THRESHOLD - 0.01;
  }

  return score;
}

/** Same-person threshold used for automatic attach (tracked-people, voiceprints). */
export const SAME_PERSON_THRESHOLD = 0.85;
/** Candidates in [REVIEW_THRESHOLD, auto) are surfaced for human triage, never auto-merged. */
export const REVIEW_THRESHOLD = 0.72;
