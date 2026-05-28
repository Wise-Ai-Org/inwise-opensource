import { api } from '../api';
import type {
  Task,
  TasksAdapter,
  TaskScore,
  JiraProject,
  JiraStory,
  JiraTaskAdapter,
  SorWrite,
  SorTaskAdapter,
  SorTargetSystem,
} from '@inwise/desktop-shared';

function toSorWrite(entry: any): SorWrite {
  return {
    _id: entry._id,
    targetSystem: entry.targetSystem ?? 'jira',
    targetRecordId: entry.targetRecordId ?? '',
    targetRecordUrl: entry.targetRecordUrl ?? null,
    operation: entry.operation ?? 'create',
    result: entry.result ?? 'pending',
    errorMessage: entry.errorMessage ?? null,
    createdAt: entry.createdAt ?? new Date().toISOString(),
    retryCount: entry.retryCount ?? 0,
  };
}

function toJiraProject(p: any): JiraProject {
  return { id: p.id ?? p._id ?? '', key: p.key ?? '', name: p.name ?? '' };
}

function toJiraStory(s: any): JiraStory {
  return {
    id: s.id ?? s.key ?? '',
    key: s.key ?? '',
    summary: s.summary ?? s.title ?? '',
    status: s.status ?? '',
    assignee: s.assignee,
  };
}

const jira: JiraTaskAdapter = {
  async connect() { await api.jiraConnect(); },
  async disconnect() { await api.jiraDisconnect(); },
  async status() { return api.jiraStatus(); },
  async getProjects(): Promise<JiraProject[]> {
    const projects = await api.jiraGetProjects();
    return (projects ?? []).map(toJiraProject);
  },
  async getStories(projectKey: string): Promise<JiraStory[]> {
    const stories = await api.jiraGetStories(projectKey);
    return (stories ?? []).map(toJiraStory);
  },
  async createIssue(projectKey: string, fields: Record<string, unknown>): Promise<JiraStory> {
    const result = await api.jiraCreateIssue({ projectKey, ...fields });
    return toJiraStory(result);
  },
  async updateIssue(issueKey: string, fields: Record<string, unknown>): Promise<JiraStory> {
    const result = await api.jiraUpdateIssue(issueKey, fields);
    return toJiraStory(result);
  },
  async transition(issueKey: string, transitionId: string): Promise<void> {
    await api.jiraTransition(issueKey, transitionId);
  },
  async addComment(issueKey: string, body: string): Promise<void> {
    await api.jiraAddComment(issueKey, body);
  },
  async linkTask(taskId: string, issueKey: string): Promise<void> {
    await api.jiraLinkTask(taskId, issueKey, '');
  },
  async matchTasks(): Promise<{ taskId: string; issueKey: string; confidence: number }[]> {
    const tasks = await api.getTasks();
    const matches = await api.jiraMatchTasks(tasks ?? []);
    return (matches ?? []).map((m: any) => ({
      taskId: m.taskId ?? '',
      issueKey: m.issueKey ?? m.jiraKey ?? '',
      confidence: m.confidence ?? 0,
    }));
  },
};

const sor: SorTaskAdapter = {
  async listByTaskId(taskId: string): Promise<SorWrite[]> {
    const entries = await api.sorListByTaskId(taskId);
    return (entries ?? []).map(toSorWrite);
  },
  async listByTargetRecord(system: SorTargetSystem, recordId: string): Promise<SorWrite[]> {
    const entries = await api.sorListByTargetRecord(system, recordId);
    return (entries ?? []).map(toSorWrite);
  },
  async listFailed(system: SorTargetSystem): Promise<SorWrite[]> {
    const entries = await api.sorListFailed(system, 0);
    return (entries ?? []).map(toSorWrite);
  },
  async retryFailed(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await api.sorRetry(id);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  },
};

export const ossTasksAdapter: TasksAdapter = {
  async listTasks(opts): Promise<Task[]> {
    const tasks = await api.getTasks();
    if (!opts?.includeSnoozed) return tasks ?? [];
    const snoozed = await api.getSnoozedTasks();
    const all = [...(tasks ?? []), ...(snoozed ?? [])];
    const seen = new Set<string>();
    return all.filter(t => { if (seen.has(t._id)) return false; seen.add(t._id); return true; });
  },

  async createTask(data): Promise<Task> {
    return api.createTask(data);
  },

  async updateTask(id: string, updates): Promise<Task | null> {
    return api.updateTask(id, updates);
  },

  async deleteTask(id: string): Promise<boolean> {
    const result = await api.deleteTask(id);
    return result !== false;
  },

  async snoozeTask(id: string, reason: string): Promise<boolean> {
    return api.snoozeTask(id, reason);
  },

  async bringBackTask(id: string): Promise<boolean> {
    return api.bringBackTask(id);
  },

  async bringBackAllTasks(): Promise<number> {
    const result = await api.bringBackAllTasks();
    return typeof result === 'number' ? result : 0;
  },

  async confirmLikelyDone(id: string): Promise<boolean> {
    return api.confirmLikelyDone(id);
  },

  async rejectLikelyDone(id: string): Promise<boolean> {
    return api.rejectLikelyDone(id);
  },

  async suggestTaskFields(title: string): Promise<Partial<Task>> {
    const result = await api.suggestTaskFields({ title, modalType: 'task-creation' });
    return result ?? {};
  },

  async scoredTasks(): Promise<TaskScore[]> {
    const result = await api.getScoredTasks();
    return (result ?? []).map((s: any) => ({
      taskId: s.taskId ?? s._id ?? '',
      score: s.score ?? 0,
      rationale: s.rationale ?? s.reasoning ?? '',
    }));
  },

  jira,
  sor,
};
