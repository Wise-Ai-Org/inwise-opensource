import Store from 'electron-store';

interface Config {
  apiProvider: 'anthropic' | 'openai';
  apiKey: string;
  whisperModel: 'tiny' | 'base' | 'small' | 'medium';
  googleIcsUrl: string;
  outlookIcsUrl: string;
  onboardingComplete: boolean;
}

const store = new Store<Config>({
  defaults: {
    apiProvider: 'anthropic',
    apiKey: '',
    whisperModel: 'base',
    googleIcsUrl: '',
    outlookIcsUrl: '',
    onboardingComplete: false,
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
