export interface TranscriptQuality {
  ok: boolean;
  score: number;
  reasons: string[];
  wordCount: number;
  uniqueWordRatio: number;
  maxRepeatedFiveGram: number;
  maxLocalRepeatedFiveGram: number;
  repeatedAnnotationCount: number;
  speakerMarkerCount: number;
}

const NO_SPEECH_TEXT = /^(?:\(?no speech detected\)?|\[?blank_audio\]?|\s*)$/i;

function normalizedWords(text: string): string[] {
  return text
    .replace(/\[SPEAKER_TURN\]/gi, ' ')
    .replace(/^\s*(?:\[[^\]]+\]|speaker\s+\d+|[^:\n]{1,40}):\s*/gim, ' ')
    .toLowerCase()
    .match(/[a-z0-9']+/g) || [];
}

function maxRepeatedNGram(words: string[], size: number): number {
  if (words.length < size) return 0;
  const counts = new Map<string, number>();
  let max = 0;
  for (let i = 0; i <= words.length - size; i++) {
    const gram = words.slice(i, i + size).join(' ');
    const count = (counts.get(gram) || 0) + 1;
    counts.set(gram, count);
    if (count > max) max = count;
  }
  return max;
}

function maxLocalRepeatedNGram(words: string[], size: number, windowSize = 240): number {
  if (words.length < size) return 0;
  let max = 0;
  const stride = Math.max(1, Math.floor(windowSize / 2));
  for (let start = 0; start < words.length; start += stride) {
    const end = Math.min(words.length, start + windowSize);
    max = Math.max(max, maxRepeatedNGram(words.slice(start, end), size));
    if (end === words.length) break;
  }
  return max;
}

function speakerMarkerCount(text: string): number {
  return text.match(/[\[(]?\s*speaker(?:[_\s]?\d+|[_\s]?\?)\s*[\])]?:?/gi)?.length || 0;
}

function repeatedAnnotationCount(text: string): number {
  const annotations = text.match(/[([]\s*[^()[\]\n]{2,50}\s*[)\]]/g) || [];
  const counts = new Map<string, number>();
  let repeated = 0;
  for (const annotation of annotations) {
    // Speaker markers are a diarization/export issue, not non-speech. Keep a
    // separate count so they cannot hide or distort the ASR quality decision.
    if (/^[([]\s*speaker(?:[_\s]?\d+|[_\s]?\?)\s*[)\]]/i.test(annotation)) continue;
    const normalized = annotation.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!normalized) continue;
    const next = (counts.get(normalized) || 0) + 1;
    counts.set(normalized, next);
    if (next >= 3) repeated++;
  }
  return repeated;
}

/**
 * Flags common Whisper failure modes without judging normal wording or grammar.
 * The checks target runaway phrase loops, repeated sound annotations and very
 * low lexical diversity. A no-speech result is valid and should not cause an
 * expensive retry.
 */
export function assessTranscriptQuality(text: string): TranscriptQuality {
  const trimmed = text.trim();
  if (NO_SPEECH_TEXT.test(trimmed)) {
    return {
      ok: true,
      score: 100,
      reasons: [],
      wordCount: 0,
      uniqueWordRatio: 1,
      maxRepeatedFiveGram: 0,
      maxLocalRepeatedFiveGram: 0,
      repeatedAnnotationCount: 0,
      speakerMarkerCount: 0,
    };
  }

  const words = normalizedWords(trimmed);
  const wordCount = words.length;
  const uniqueWordRatio = wordCount === 0 ? 0 : new Set(words).size / wordCount;
  const maxRepeatedFiveGram = maxRepeatedNGram(words, 5);
  const maxLocalRepeatedFiveGram = maxLocalRepeatedNGram(words, 5);
  const annotations = repeatedAnnotationCount(trimmed);
  const markers = speakerMarkerCount(trimmed);
  const reasons: string[] = [];

  // A short phrase repeated several times inside a local window is a classic
  // Whisper hallucination even when the whole meeting is otherwise long. The
  // old global-coverage rule missed the six-copy loop in the Sep 11 interview.
  if (maxLocalRepeatedFiveGram >= 4) {
    reasons.push(`localized repeated phrase loop (${maxLocalRepeatedFiveGram} copies)`);
  }
  if (annotations >= 4) {
    reasons.push(`repeated non-speech annotation (${annotations + 2} copies)`);
  }
  if (wordCount >= 80 && uniqueWordRatio < 0.12) {
    reasons.push(`very low lexical diversity (${Math.round(uniqueWordRatio * 100)}%)`);
  }

  const score = Math.max(0, 100
    - (maxRepeatedFiveGram >= 5 ? Math.min(55, maxRepeatedFiveGram * 3) : 0)
    - (maxLocalRepeatedFiveGram >= 4 ? Math.min(45, maxLocalRepeatedFiveGram * 7) : 0)
    - Math.min(35, annotations * 4)
    - (wordCount >= 80 && uniqueWordRatio < 0.12 ? 25 : 0));

  return {
    ok: reasons.length === 0,
    score,
    reasons,
    wordCount,
    uniqueWordRatio,
    maxRepeatedFiveGram,
    maxLocalRepeatedFiveGram,
    repeatedAnnotationCount: annotations,
    speakerMarkerCount: markers,
  };
}

export function chooseBetterTranscript(first: string, retry: string): string {
  const a = assessTranscriptQuality(first);
  const b = assessTranscriptQuality(retry);
  if (b.score !== a.score) return b.score > a.score ? retry : first;
  if (b.ok !== a.ok) return b.ok ? retry : first;
  return b.wordCount > a.wordCount ? retry : first;
}

export function buildMeetingPrompt(
  meetingTitle?: string,
  attendees: string[] = [],
  userName?: string,
): string {
  const clean = (value: string) => value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  const names = [userName || '', ...attendees]
    .map(clean)
    .filter(Boolean)
    .filter((name, index, all) => all.findIndex(n => n.toLowerCase() === name.toLowerCase()) === index)
    .slice(0, 6);
  const parts = [
    meetingTitle ? `Meeting: ${clean(meetingTitle).slice(0, 80)}.` : '',
    names.length ? `Names: ${names.join(', ')}.` : '',
  ].filter(Boolean);
  return parts.join(' ').slice(0, 180);
}

/** Turn TinyDiarize speaker-change tokens into stable generic speaker labels. */
export function formatTinyDiarization(text: string): string {
  if (!/\[SPEAKER_TURN\]/i.test(text)) return text.trim();
  const parts = text.split(/(\[SPEAKER_TURN\])/gi);
  const turns: string[] = [];
  let speaker = 1;
  let pending = '';

  const flush = () => {
    const cleaned = pending.replace(/\s+/g, ' ').trim();
    if (cleaned) turns.push(`Speaker ${speaker}: ${cleaned}`);
    pending = '';
  };

  for (const part of parts) {
    if (/^\[SPEAKER_TURN\]$/i.test(part)) {
      flush();
      speaker = speaker === 1 ? 2 : 1;
    } else {
      pending += ` ${part}`;
    }
  }
  flush();
  return turns.join('\n');
}

export type MeetingType = 'customer' | 'internal' | 'sales' | 'hiring' | 'one_on_one' | 'planning' | 'support' | 'project' | 'general';

/** Conservative title/transcript hint used only to shape extraction, never to invent facts. */
export function inferMeetingType(title = '', transcript = ''): MeetingType {
  const value = `${title} ${transcript.slice(0, 1800)}`.toLowerCase();
  if (/interview|candidate|hiring|recruit/.test(value)) return 'hiring';
  if (/support|incident|bug|outage|ticket/.test(value)) return 'support';
  if (/one[- ]?on[- ]?one|1:1|career|manager/.test(value)) return 'one_on_one';
  if (/customer|client|prospect|demo|discovery|buyer|sales/.test(value)) return 'customer';
  if (/planning|roadmap|sprint|standup|retro/.test(value)) return 'planning';
  if (/project|launch|delivery|implementation/.test(value)) return 'project';
  return 'general';
}

/** Reject malformed or stale extracted dates before they become tasks. */
export function sanitizeDueDate(value: unknown, meetingDate?: string, now = new Date()): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`).getTime();
  if (!Number.isFinite(parsed)) return undefined;
  const reference = meetingDate ? new Date(meetingDate).getTime() : now.getTime();
  if (Number.isFinite(reference) && parsed < new Date(reference).setUTCHours(0, 0, 0, 0)) return undefined;
  return value;
}

export function computeExtractionCoverage(input: {
  transcript: string;
  summary?: string;
  actionItems?: unknown[];
  decisions?: unknown[];
  blockers?: unknown[];
  signals?: unknown[];
  missing?: string[];
}): { score: number; missing: string[] } {
  const transcriptPresent = input.transcript.trim().length > 0;
  const areas = [!!input.summary, !!input.actionItems?.length, !!input.decisions?.length, !!input.blockers?.length, !!input.signals?.length];
  const score = transcriptPresent ? Math.max(0, Math.min(1, areas.filter(Boolean).length / areas.length)) : 0;
  return { score, missing: [...new Set(input.missing || [])].slice(0, 12) };
}

/** Resolve Whisper's channel labels without pretending an unknown person is the user. */
export function normalizeSpeakerLabels(transcript: string, userName = '', attendees: string[] = []): string {
  const others = attendees.filter((name) => name && name.trim().toLowerCase() !== userName.trim().toLowerCase());
  const speakerMap: Record<string, string> = {};
  if (userName.trim()) speakerMap['0'] = userName.trim();
  speakerMap['1'] = others.length === 1 ? others[0] : others.length > 1 ? 'Others' : 'Other speaker';
  return transcript
    .replace(/[\[(]?SPEAKER[_\s]?(\d+)[\])]?:?/gi, (match, number) => speakerMap[number] ? `${speakerMap[number]}:` : match)
    .replace(/[\[(]?SPEAKER[_\s]?\?[\])]?:?/gi, 'Other speaker:');
}
