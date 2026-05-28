import type { ToastWindowAdapter, MeetingToastEvent } from '@inwise/desktop-shared';

const api = (window as any).toastAPI;

interface OSSMeetingEvent {
  id: string;
  title: string;
  startTime: Date | number | string;
  meetingLink?: string;
  attendees?: string[];
}

export const ossToastAdapter: ToastWindowAdapter = {
  onMeetingStarting(handler: (event: MeetingToastEvent) => void): () => void {
    const cb = (payload: OSSMeetingEvent) => {
      const startMs =
        payload.startTime instanceof Date
          ? payload.startTime.getTime()
          : typeof payload.startTime === 'number'
          ? payload.startTime
          : Date.parse(String(payload.startTime));
      handler({
        id: payload.id,
        title: payload.title,
        attendeeFirstName: payload.attendees?.[0]?.split(' ')[0] || undefined,
        joinUrl: payload.meetingLink || undefined,
        startsAt: new Date(startMs).toISOString(),
      });
    };
    api.on('meeting:reminder', cb);
    return () => api.off('meeting:reminder', cb);
  },

  async dismiss(_toastId: string): Promise<void> {
    api.dismiss();
  },

  async openJoinUrl(url: string): Promise<void> {
    await api.openJoinUrl(url);
  },
};
