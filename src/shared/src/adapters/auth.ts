// inwise-desktop-shared — AuthAdapter interface
// NO runtime code — interfaces and type aliases only.

export interface User {
  _id: string;
  email: string;
  name?: string;
  /** Matches config.apiProvider — 'anthropic' | 'openai' */
  apiProvider?: string;
}

export interface AuthAdapter {
  getCurrentUser(): Promise<User | null>;
  /** OSS only: returns the configured API key(s) for AI provider access. */
  getApiKeys?(): Promise<{ provider: string; key: string }[]>;
  /** SDK only: exchanges a first-party session for a scoped access token. */
  getAccessToken?(scope: string): Promise<string>;
  signOut(): Promise<void>;
}
