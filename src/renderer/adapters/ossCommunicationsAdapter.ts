import { api } from '../api';
import type {
  CommunicationsAdapter,
  MeetingSummary,
  MeetingDetail,
  TranscriptReviewEdits,
  TranscriptUploadPayload,
  JiraLink,
  ConversationMapping,
} from '@inwise/desktop-shared';

function toISO(date: string | number | undefined): string {
  if (!date) return new Date().toISOString();
  if (typeof date === 'number') return new Date(date).toISOString();
  return date;
}

function toSummary(m: any): MeetingSummary {
  return {
    _id: m._id,
    title: m.title ?? 'Untitled',
    date: toISO(m.date),
    duration: m.duration ?? 0,
    attendees: m.attendees ?? [],
    status: m.status ?? 'pending',
    hasTranscript: m.hasTranscript ?? false,
    hasInsights: m.hasInsights ?? false,
    actionItemCount: m.actionItemCount ?? 0,
    createdAt: toISO(m.createdAt ?? m.date),
  };
}

function toDetail(m: any): MeetingDetail | null {
  if (!m) return null;
  return {
    ...toSummary(m),
    transcript: m.transcript ?? null,
    insights: m.insights
      ? {
          summary: m.insights.summary ?? '',
          actionItems: m.insights.actionItems ?? [],
          decisions: m.insights.decisions ?? [],
          blockers: m.insights.blockers ?? [],
          commitments: m.insights.commitments ?? [],
          contradictions: m.insights.contradictions ?? [],
        }
      : null,
  };
}

export const ossCommunicationsAdapter: CommunicationsAdapter = {
  async listMeetings(): Promise<MeetingSummary[]> {
    const meetings = await api.getMeetings();
    return (meetings ?? []).map(toSummary);
  },

  async getMeeting(id: string): Promise<MeetingDetail | null> {
    const m = await api.getMeeting(id);
    return toDetail(m);
  },

  async deleteMeeting(id: string): Promise<boolean> {
    await api.deleteMeeting(id);
    return true;
  },

  // OSS reviewMeeting marks the meeting as reviewed but does not persist edits.
  async reviewMeeting(id: string, _edits: TranscriptReviewEdits): Promise<MeetingDetail | null> {
    await api.reviewMeeting(id);
    const m = await api.getMeeting(id);
    return toDetail(m);
  },

  async createMeetingFromTranscript(payload: TranscriptUploadPayload): Promise<MeetingSummary> {
    const m = await api.createMeetingFromTranscript({
      title: payload.title,
      content: payload.content,
      date: payload.date,
    });
    return toSummary(m);
  },

  async generateAgenda(personId: string): Promise<string> {
    const result = await api.generateAgenda(personId);
    const agenda = result?.agenda ?? [];
    return Array.isArray(agenda) ? agenda.join('\n') : String(agenda);
  },

  async linkMeetingToJira(meetingId: string, issueKey: string): Promise<JiraLink> {
    const meeting = await api.getMeeting(meetingId);
    await api.jiraAddComment(issueKey, `Linked meeting: ${meetingId}`, meeting?.title);
    return { meetingId, issueKey };
  },

  async getConversationMappings(): Promise<ConversationMapping[]> {
    return [];
  },

  async updateConversationMapping(personId: string, meetingIds: string[]): Promise<ConversationMapping> {
    return {
      personId,
      personName: '',
      meetingIds,
      lastMeeting: meetingIds[meetingIds.length - 1] ?? null,
    };
  },
};
