import Store from 'electron-store';

interface Config {
  apiProvider: 'anthropic' | 'openai';
  apiKey: string;
  whisperModel: 'tiny' | 'base' | 'small' | 'medium';
  googleIcsUrl: string;
  outlookIcsUrl: string;
  micDeviceId: string;
  userName: string;
  onboardingComplete: boolean;
  firstTimeFlowCount: number;
  jiraClientId: string;
  jiraClientSecret: string;
  jiraTokens: any | null;
  jiraAutoPush: boolean;
  jiraDefaultProject: string;
}

const store = new Store<Config>({
  defaults: {
    apiProvider: 'anthropic',
    apiKey: '',
    whisperModel: 'base',
    googleIcsUrl: '',
    outlookIcsUrl: '',
    micDeviceId: 'default',
    userName: '',
    onboardingComplete: false,
    firstTimeFlowCount: 0,
    jiraClientId: '',
    jiraClientSecret: '',
    jiraTokens: null,
    jiraAutoPush: false,
    jiraDefaultProject: '',
  },
});

export function getConfig(): Config {
  return store.store;
}

export function setConfig(updates: Partial<Config>): void {
  for (const [key, value] of Object.entries(updates)) {
    store.set(key as keyof Config, value);
  }
}

export function isOnboardingComplete(): boolean {
  return store.get('onboardingComplete') && store.get('apiKey') !== '';
}
