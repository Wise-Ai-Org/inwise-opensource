import * as assert from 'node:assert/strict';
import { parseTeamsVtt } from './teams-vtt-parser';
import type { TeamsTranscriptArtifact } from './teams-api';

const base: Omit<TeamsTranscriptArtifact, 'content' | 'speakerAttributed'> = {
  meeting: {
    eventId: 'event-1',
    title: 'Planning',
    startedAt: '2026-08-01T10:00:00Z',
    endedAt: '2026-08-01T10:30:00Z',
    joinWebUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
  },
  onlineMeetingId: 'online-1',
  transcriptId: 'transcript-1',
  createdAt: '2026-08-01T10:31:00Z',
};

async function run(): Promise<void> {
  const voiceTagged = parseTeamsVtt({
    ...base,
    speakerAttributed: true,
    content: 'WEBVTT\n\n00:00:01.000 --> 00:00:03.500\n<v Alice Smith>Hello &amp; welcome.</v>\n\n00:00:04.000 --> 00:00:05.000\n<v Bob>Hi.</v>',
  });
  assert.equal(voiceTagged.segments.length, 2);
  assert.deepEqual(voiceTagged.segments[0], {
    speaker: 'Alice Smith', startMs: 1000, endMs: 3500, text: 'Hello & welcome.',
  });

  const jsonCues = parseTeamsVtt({
    ...base,
    speakerAttributed: true,
    content: 'WEBVTT\n\n00:00:03.663 --> 00:00:07.903\n{"speakerName":"MOD Administrator","spokenText":"Hello.","spokenLanguage":"en-us"}',
  });
  assert.equal(jsonCues.segments[0].speaker, 'MOD Administrator');
  assert.equal(jsonCues.segments[0].text, 'Hello.');

  const unattributed = parseTeamsVtt({
    ...base,
    speakerAttributed: false,
    content: '00:00:01.500 --> 00:00:04.000\n\nThanks for joining.',
  });
  assert.equal(unattributed.externalId, 'online-1:transcript-1');
  assert.equal(unattributed.segments[0].speaker, 'Unknown speaker');
  assert.equal(unattributed.segments[0].text, 'Thanks for joining.');

  console.log('teams-vtt-parser: all tests passed');
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { run };
