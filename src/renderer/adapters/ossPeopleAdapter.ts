import { api } from '../api';
import type { PeopleAdapter, Person, SuggestedPerson } from '@inwise/desktop-shared';

function toPerson(p: any): Person {
  return {
    _id: p._id,
    name: p.name ?? '',
    email: p.email ?? null,
    company: p.company ?? null,
    role: p.role ?? null,
    bio: p.bio ?? null,
    notes: p.notes ?? null,
    relationshipInsights: p.relationshipInsights ?? [],
    archived: p.archived ?? false,
    trackedBy: p.trackedBy ?? false,
    createdAt: p.createdAt ?? new Date().toISOString(),
    meetingCount: p.meetingCount,
    lastMeeting: p.lastMeeting ?? null,
    firstMeeting: p.firstMeeting ?? null,
    actionItemCount: p.actionItemCount,
    daysSinceLastContact: p.daysSinceLastContact ?? null,
    relationshipDuration: p.relationshipDuration,
    engagementScore: p.engagementScore,
    recentMeetings: p.recentMeetings,
  };
}

function toSuggestedPerson(p: any): SuggestedPerson {
  return {
    _id: p._id,
    name: p.name ?? '',
    email: p.email ?? null,
    company: p.company ?? null,
    meetingCount: p.meetingCount ?? 0,
    lastMeeting: p.lastMeeting ?? null,
  };
}

export const ossPeopleAdapter: PeopleAdapter = {
  async listPeople(search?: string): Promise<Person[]> {
    const people = await api.getPeople(search);
    return (people ?? []).map(toPerson);
  },

  async getPerson(id: string): Promise<Person | null> {
    const person = await api.getPerson(id);
    return person ? toPerson(person) : null;
  },

  async addPerson(data): Promise<Person> {
    const person = await api.addPerson(data);
    return toPerson(person);
  },

  async addTrackedPeople(ids: string[]): Promise<void> {
    // OSS backend (db:addTrackedPeople) searches by name, not _id — resolve names first
    const persons = await Promise.all(ids.map(id => api.getPerson(id)));
    const names = persons
      .filter((p): p is any => p != null)
      .map(p => p.name as string)
      .filter(Boolean);
    if (names.length > 0) {
      await api.addTrackedPeople(names);
    }
  },

  async archivePerson(id: string): Promise<boolean> {
    const result = await api.archivePerson(id);
    return result !== false;
  },

  async unarchivePerson(id: string): Promise<boolean> {
    const result = await api.unarchivePerson(id);
    return result !== false;
  },

  async getSuggestedPeople(): Promise<SuggestedPerson[]> {
    const people = await api.getSuggestedPeople();
    return (people ?? []).map(toSuggestedPerson);
  },

  async generatePersonInsights(personId: string): Promise<string> {
    const result = await api.generatePersonInsights(personId);
    if (Array.isArray(result)) return result.join('\n');
    return typeof result === 'string' ? result : JSON.stringify(result ?? '');
  },

  async generateAgenda(personId: string): Promise<string> {
    const result = await api.generateAgenda(personId);
    if (Array.isArray(result)) return result.join('\n');
    return typeof result === 'string' ? result : JSON.stringify(result ?? '');
  },
};
