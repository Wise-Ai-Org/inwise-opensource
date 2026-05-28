import type {
  OnboardingAdapter,
  OnboardingStep,
  JiraSettingsAdapter,
  VoiceAdapter,
  VoiceprintEntry,
} from '@inwise/desktop-shared';
import { ossCalendarAdapter } from './ossCalendarAdapter';

const api = (window as any).inwiseAPI;

const jira: JiraSettingsAdapter = {
  async isConnected(): Promise<boolean> {
    const status = await api.jiraStatus?.().catch(() => null);
    return (status?.connected as boolean) ?? false;
  },
  async connect(): Promise<void> {
    const result = await api.jiraConnect();
    if (!result?.ok) throw new Error(result?.error ?? 'Jira connection failed');
  },
  async disconnect(): Promise<void> {
    await api.jiraDisconnect();
  },
};

const voiceprint: VoiceAdapter = {
  async list(): Promise<VoiceprintEntry[]> {
    const prints: any[] = (await api.getVoicePrints()) ?? [];
    return prints.map((p: any) => ({
      id: p._id ?? p.id,
      name: p.name ?? '',
      isUser: p.isUser ?? false,
      createdAt: p.createdAt ?? new Date().toISOString(),
    }));
  },
  async record(name: string, isUser: boolean, audioClip: ArrayBuffer) {
    const result = await api.saveVoicePrint({ name, isUser, audioClip: new Uint8Array(audioClip) });
    return { ok: result?.ok ?? false, id: result?.id, error: result?.error };
  },
  async delete(id: string): Promise<boolean> {
    await api.deleteVoicePrint(id);
    return true;
  },
};

export const ossOnboardingAdapter: OnboardingAdapter = {
  async getStep(): Promise<OnboardingStep> {
    const cfg = await api.getConfig();
    return (cfg?.onboardingStep as OnboardingStep) ?? 'calendar';
  },
  async setStep(step: OnboardingStep): Promise<void> {
    await api.setConfig({ onboardingStep: step });
  },
  calendar: ossCalendarAdapter,
  jira,
  voiceprint,
};
