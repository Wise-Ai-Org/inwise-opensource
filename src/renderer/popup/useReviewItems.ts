import { useCallback, useEffect, useState } from 'react';
import { api } from './nav';

export interface ApprovalItem {
  writeEntry: any;
  pending: {
    _id: string;
    targetSystem: 'jira';
    pushParams: any;
    meetingTitle: string | null;
    linkedTaskId: string | null;
    createdAt: string;
  };
}

export interface SuggestedPersonItem {
  name: string;
  meetingCount: number;
  recentMeetings: Array<{ _id: string; title: string; date: string }>;
}

export interface UnknownVoiceItem {
  _id: string;
  name: string; // "Unidentified (Sam, Rosa)"
  createdAt: string;
  hasAudio: boolean;
  candidates: string[]; // parsed from the label
}

export interface ScoredTaskItem {
  _id: string;
  title: string;
  priorityScore?: number;
  priorityReasoning?: string;
  status?: string;
  dueDate?: string | null;
}

export interface ReviewItems {
  approvals: ApprovalItem[];
  suggested: SuggestedPersonItem[];
  unknownVoices: UnknownVoiceItem[];
  scoredTasks: ScoredTaskItem[];
  loaded: boolean;
  /** approvals + suggested people + unknown voices (priorities never inflate the badge) */
  count: number;
  reload: () => void;
}

function parseUnidentifiedCandidates(label: string): string[] {
  const m = /^Unidentified \((.*)\)$/.exec(label);
  if (!m) return [];
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

export function useReviewItems(): ReviewItems {
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [suggested, setSuggested] = useState<SuggestedPersonItem[]>([]);
  const [unknownVoices, setUnknownVoices] = useState<UnknownVoiceItem[]>([]);
  const [scoredTasks, setScoredTasks] = useState<ScoredTaskItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    const a = api();
    Promise.allSettled([
      a.sorListPendingApprovals?.(),
      a.getSuggestedPeople?.(),
      a.getVoicePrints?.(),
      a.getScoredTasks?.(),
    ]).then(([ap, sp, vp, st]) => {
      setApprovals(ap.status === 'fulfilled' && Array.isArray(ap.value) ? ap.value : []);
      setSuggested(sp.status === 'fulfilled' && Array.isArray(sp.value) ? sp.value : []);
      if (vp.status === 'fulfilled' && Array.isArray(vp.value)) {
        setUnknownVoices(
          vp.value
            .filter((p: any) => !p.isUser && typeof p.name === 'string' && p.name.startsWith('Unidentified'))
            .map((p: any) => ({
              _id: p._id,
              name: p.name,
              createdAt: p.createdAt,
              hasAudio: !!p.hasAudio,
              candidates: parseUnidentifiedCandidates(p.name),
            })),
        );
      } else {
        setUnknownVoices([]);
      }
      if (st.status === 'fulfilled') {
        const raw = Array.isArray(st.value) ? st.value : (st.value?.scoredTasks || []);
        setScoredTasks(
          raw
            .filter((t: any) => t && t.status !== 'completed' && t.status !== 'cancelled')
            .sort((x: any, y: any) => (y.priorityScore ?? 0) - (x.priorityScore ?? 0)),
        );
      } else {
        setScoredTasks([]);
      }
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    reload();
    const a = api();
    const onChanged = () => reload();
    a.on?.('sor:write-completed', onChanged);
    a.on?.('tasks:reprioritized', onChanged);
    a.on?.('meeting:new', onChanged);
    const timer = setInterval(reload, 60_000);
    return () => {
      a.off?.('sor:write-completed', onChanged);
      a.off?.('tasks:reprioritized', onChanged);
      a.off?.('meeting:new', onChanged);
      clearInterval(timer);
    };
  }, [reload]);

  return {
    approvals,
    suggested,
    unknownVoices,
    scoredTasks,
    loaded,
    count: approvals.length + suggested.length + unknownVoices.length,
    reload,
  };
}
