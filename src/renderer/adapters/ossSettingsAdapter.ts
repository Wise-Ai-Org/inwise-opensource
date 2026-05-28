import type {
  SettingsAdapter,
  AIProviderAdapter,
  TranscriptionSettingsAdapter,
  IntegrationsAdapter,
  VoiceAdapter,
  VoiceprintEntry,
  DataManagementAdapter,
} from '@inwise/desktop-shared';

const api = (window as any).inwiseAPI;

const ossAIAdapter: AIProviderAdapter = {
  async getProvider() {
    const cfg = await api.getConfig();
    return (cfg?.apiProvider as 'anthropic' | 'openai') ?? 'anthropic';
  },
  async setProvider(provider) {
    await api.setConfig({ apiProvider: provider });
  },
  async getApiKey() {
    const cfg = await api.getConfig();
    return (cfg?.apiKey as string) ?? '';
  },
  async setApiKey(key) {
    await api.setConfig({ apiKey: key });
  },
};

const ossTranscriptionAdapter: TranscriptionSettingsAdapter = {
  async getWhisperModel() {
    const cfg = await api.getConfig();
    return (cfg?.whisperModel as 'tiny' | 'base' | 'small' | 'medium') ?? 'base';
  },
  async setWhisperModel(model) {
    await api.setConfig({ whisperModel: model });
  },
  async getAudioDeviceId() {
    const cfg = await api.getConfig();
    return cfg?.micDeviceId as string | undefined;
  },
  async setAudioDeviceId(id) {
    await api.setConfig({ micDeviceId: id });
  },
};

const ossIntegrationsAdapter: IntegrationsAdapter = {
  jira: {
    async isConnected() {
      const status = await api.jiraStatus?.().catch(() => null);
      return (status?.connected as boolean) ?? false;
    },
    async connect() {
      const result = await api.jiraConnect();
      if (!result?.ok) throw new Error(result?.error ?? 'Jira connection failed');
    },
    async disconnect() {
      await api.jiraDisconnect();
    },
  },
};

const ossVoiceAdapter: VoiceAdapter = {
  async list(): Promise<VoiceprintEntry[]> {
    const prints: any[] = await api.getVoicePrints();
    return prints.map((p) => ({
      id: p._id,
      name: p.name,
      isUser: p.isUser,
      createdAt: p.createdAt,
    }));
  },
  async record(name, isUser, audioClip) {
    const result = await api.saveVoicePrint({ name, isUser, audioClip: new Uint8Array(audioClip) });
    return { ok: result?.ok ?? false, id: result?.id, error: result?.error };
  },
  async delete(id) {
    await api.deleteVoicePrint(id);
    return true;
  },
};

const ossDataAdapter: DataManagementAdapter = {
  async seedDemo() {
    await api.seedDemoData();
  },
  async clearDemo() {
    await api.clearDemoData();
  },
  async exportDb() {
    await api.exportDb();
  },
};

export const ossSettingsAdapter: SettingsAdapter = {
  async getConfig() {
    return (await api.getConfig()) ?? {};
  },
  async setConfig(updates) {
    await api.setConfig(updates);
  },
  ai: ossAIAdapter,
  transcription: ossTranscriptionAdapter,
  integrations: ossIntegrationsAdapter,
  voice: ossVoiceAdapter,
  data: ossDataAdapter,
};
