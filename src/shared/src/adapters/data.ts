// inwise-desktop-shared — DataAdapter interfaces
// Field names mirror OSS IPC payload shapes from inwise-opensource database.ts / main.ts.
// NO runtime code — interfaces, type aliases, and const-asserted unions only.

// ── Scalar union types ────────────────────────────────────────────────────────

export type MeetingStatus = 'pending' | 'transcribed' | 'processed' | 'reviewed' | 'calendar_sync';
export type TaskStatus = 'todo' | 'in-progress' | 'done';
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';
export type TaskSourceType = 'manual' | 'meeting' | 'jira' | 'voice_memo';
export type MentionSourceType = 'meeting' | 'voice_note';
export type SorTargetSystem = 'jira';
export type SorOperation = 'create' | 'update' | 'transition' | 'comment';
export type SorApprovalPath = 'auto' | 'user' | 'opt-in-gated';
export type SorWriteResult = 'pending' | 'success' | 'failed' | 'pending-approval' | 'retrying';

// ── Entity types ──────────────────────────────────────────────────────────────

export interface ActionItem {
  text: string;
  owner?: string;
  dueDate?: string;
  priority?: string;
  isCommitment?: boolean;
}

export interface MeetingInsights {
  summary: string;
  actionItems: ActionItem[];
  decisions: { text: string; rationale?: string }[];
  blockers: { text: string; severity?: string }[];
  commitments: { text: string; who: string; deadline?: string; context?: string }[];
  contradictions: {
    text: string;
    previousDecision: string;
    previousMeetingTitle?: string;
    previousMeetingDate?: string;
  }[];
}

export interface Meeting {
  _id: string;
  title: string;
  date: string;              // ISO 8601
  duration: number;          // seconds
  attendees: string[];
  transcript: string | null;
  status: MeetingStatus;
  source: string;
  calendarEventId: string | null;
  insights: MeetingInsights | null;
  createdAt: string;
  // computed fields present in list() results
  hasTranscript?: boolean;
  hasInsights?: boolean;
  actionItemCount?: number;
  blockerCount?: number;
  decisionCount?: number;
  commitmentCount?: number;
  contradictionCount?: number;
}

/**
 * One recorded mention of a task. Additive to the singular `source` /
 * `provenance` fields, which are unchanged (task-dedup PRD US-002).
 */
export interface TaskMention {
  id: string;
  sourceType: MentionSourceType;
  sourceId: string | null;
  /** Display name of the source (meeting title / "Voice note"). */
  sourceTitle?: string | null;
  excerpt: string;
  occurredAt: string;         // ISO 8601
  /** Snapshot of the merged-away item, so undo/split can recreate it. */
  mergedItem?: {
    title: string;
    description?: string;
    owner?: string | null;
    deadline?: string | null;
  };
}

export interface Task {
  _id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  owner: string | null;
  source: { type: TaskSourceType; id?: string; url?: string };
  aiExtracted: boolean;
  approval: { status: 'pending' | 'approved' | 'rejected' | 'auto_approved'; approvedAt?: string };
  /** Every time this task came up, oldest first once there is more than one. */
  taskMentions?: TaskMention[];
  /** Length of taskMentions; 0 for manually created tasks. */
  mentionCount?: number;
  /** Ask-band match awaiting the user's yes/no in the review surface. */
  dedupSuggestion?: {
    candidateTaskId: string;
    candidateTitle: string;
    wasDone: boolean;
    confidence: number;
    retrievalScore: number;
    model: string;
  };
  /** mentionCount at the moment the repetition chip was dismissed. */
  nudgeDismissedAtCount?: number | null;
  /** Set when this task lost a manual merge; the survivor's id. */
  mergedInto?: string;
  archivedAt: string | null;
  snoozedAt: string | null;
  snoozedReason: string | null;
  lastMentionedAt: string | null;
  likelyDone: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Person {
  _id: string;
  name: string;
  email: string | null;
  company: string | null;
  role: string | null;
  bio: string | null;
  notes: string | null;
  relationshipInsights: string[];
  archived: boolean;
  trackedBy: boolean;
  createdAt: string;
  // computed stats present in list()/get() results
  meetingCount?: number;
  lastMeeting?: string | null;
  firstMeeting?: string | null;
  actionItemCount?: number;
  daysSinceLastContact?: number | null;
  relationshipDuration?: number;
  engagementScore?: number;
  recentMeetings?: { _id: string; title: string; date: string }[];
}

export interface Voiceprint {
  _id: string;
  name: string;
  isUser: boolean;
  personId: string | null;
  createdAt: string;
  hasAudio: boolean;
  hasEmbedding: boolean;
}

export interface SorFieldDiff {
  field: string;
  before: unknown;
  after: unknown;
}

export interface SorEntry {
  _id: string;
  targetSystem: SorTargetSystem;
  targetRecordId: string;
  targetRecordUrl: string | null;
  operation: SorOperation;
  fieldDiffs: SorFieldDiff[];
  commentBody: string | null;
  sourceMeetingId: string | null;
  linkedTaskId: string | null;
  confidence: number | null;   // 0..1
  approvalPath: SorApprovalPath;
  result: SorWriteResult;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  retryCount: number;
}

// ── Sub-interfaces ────────────────────────────────────────────────────────────

export interface MeetingsAPI {
  list(): Promise<Meeting[]>;
  get(id: string): Promise<Meeting | null>;
  create(data: { title: string; content: string; date: string }): Promise<Meeting>;
  update(id: string, updates: Partial<Pick<Meeting, 'status'>>): Promise<Meeting | null>;
  delete(id: string): Promise<boolean>;
}

export interface TasksAPI {
  list(opts?: { includeSnoozed?: boolean }): Promise<Task[]>;
  get(id: string): Promise<Task | null>;
  create(data: {
    title: string;
    description?: string;
    priority?: TaskPriority;
    dueDate?: string;
    status?: TaskStatus;
  }): Promise<Task>;
  update(id: string, updates: Partial<Omit<Task, '_id' | 'createdAt'>>): Promise<Task | null>;
  delete(id: string): Promise<boolean>;
  snooze(id: string, reason: string): Promise<boolean>;
  bringBack(id: string): Promise<boolean>;
  confirmLikelyDone(id: string): Promise<boolean>;
  rejectLikelyDone(id: string): Promise<boolean>;
}

export interface PeopleAPI {
  list(search?: string): Promise<Person[]>;
  get(id: string): Promise<Person | null>;
  add(data: {
    firstName: string;
    lastName: string;
    email?: string | null;
    notes?: string | null;
  }): Promise<Person>;
  archive(id: string): Promise<boolean>;
  unarchive(id: string): Promise<boolean>;
  getSuggested(): Promise<Person[]>;
  getArchived(): Promise<Person[]>;
}

export interface VoiceprintsAPI {
  list(): Promise<Voiceprint[]>;
  save(data: {
    name: string;
    audioClip: ArrayBuffer;
    isUser: boolean;
  }): Promise<{ ok: boolean; id?: string; error?: string }>;
  get(id: string): Promise<Voiceprint | null>;
  getAudio(id: string): Promise<{ audioClip: Uint8Array; name: string } | null>;
  delete(id: string): Promise<boolean>;
  getUser(): Promise<(Pick<Voiceprint, '_id' | 'name' | 'isUser' | 'createdAt'> & { hasAudio: boolean }) | null>;
}

export interface ConfigAPI {
  get(): Promise<Record<string, unknown>>;
  set(updates: Record<string, unknown>): Promise<boolean>;
}

export interface SorAPI {
  listRecent(limit?: number, sinceMs?: number): Promise<SorEntry[]>;
  listByMeeting(meetingId: string): Promise<SorEntry[]>;
  listByTask(taskId: string): Promise<SorEntry[]>;
  listByTarget(system: SorTargetSystem, recordId: string): Promise<SorEntry[]>;
  aggregate(sinceMs?: number): Promise<Record<string, unknown>>;
  retry(id: string): Promise<{ ok: boolean; error?: string }>;
  listFailed(system: SorTargetSystem, sinceMs: number): Promise<SorEntry[]>;
  listPending(): Promise<{ writeEntry: SorEntry; pending: unknown }[]>;
  approve(id: string, overrides?: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  reject(id: string): Promise<{ ok: boolean; error?: string }>;
}

export interface SearchAPI {
  semantic(query: string, opts?: { limit?: number }): Promise<{ meetings: Meeting[]; tasks: Task[] }>;
}

// ── Root adapter ──────────────────────────────────────────────────────────────

export interface DataAdapter {
  meetings: MeetingsAPI;
  tasks: TasksAPI;
  people: PeopleAPI;
  voiceprints: VoiceprintsAPI;
  config: ConfigAPI;
  sor: SorAPI;
  search: SearchAPI;
}
