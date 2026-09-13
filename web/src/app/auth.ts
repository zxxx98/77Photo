import type { ApiClient, AuthResponse, User } from './api';

export type SessionStatus = 'loading' | 'setup' | 'authenticated' | 'unauthenticated';

export interface SessionSnapshot {
  status: SessionStatus;
  user: User | null;
  error: string | null;
}

type SessionApi = Pick<ApiClient, 'me' | 'setupStatus' | 'setupAdmin' | 'login' | 'logout'> & Partial<Pick<ApiClient, 'setCsrfToken'>>;

export class SessionStore {
  private readonly api: SessionApi;
  private listeners = new Set<() => void>();
  private _csrfToken: string | null = null;
  snapshot: SessionSnapshot = { status: 'loading', user: null, error: null };

  constructor(api: SessionApi) {
    this.api = api;
  }

  get csrfToken(): string | null { return this._csrfToken; }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async restore(): Promise<void> {
    this.setSnapshot({ status: 'loading', user: null, error: null });
    try {
      const user = await this.api.me();
      this.setSnapshot({ status: 'authenticated', user, error: null });
    } catch {
      this.clearSession();
      try {
        const setup = await this.api.setupStatus();
        this.setSnapshot({ status: setup.required ? 'setup' : 'unauthenticated', user: null, error: null });
      } catch {
        this.setSnapshot({ status: 'unauthenticated', user: null, error: null });
      }
    }
  }

  async setupAdmin(username: string, password: string): Promise<void> {
    this.setSnapshot({ status: 'loading', user: null, error: null });
    try {
      const response = await this.api.setupAdmin(username, password);
      this._csrfToken = response.csrf_token;
      this.api.setCsrfToken?.(this._csrfToken);
      this.setSnapshot({ status: 'authenticated', user: response.user, error: null });
    } catch (error) {
      this.clearSession();
      await this.restore();
      throw error;
    }
  }

  async login(username: string, password: string): Promise<void> {
    this.setSnapshot({ status: 'loading', user: null, error: null });
    try {
      const response: AuthResponse = await this.api.login(username, password);
      this._csrfToken = response.csrf_token;
      this.api.setCsrfToken?.(this._csrfToken);
      this.setSnapshot({ status: 'authenticated', user: response.user, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to sign in';
      this.clearSession();
      this.setSnapshot({ status: 'unauthenticated', user: null, error: message });
      throw error;
    }
  }

  async logout(): Promise<void> {
    try {
      await this.api.logout();
    } finally {
      this.clearSession();
      this.setSnapshot({ status: 'unauthenticated', user: null, error: null });
    }
  }

  private clearSession(): void {
    this._csrfToken = null;
    this.api.setCsrfToken?.(null);
  }

  private setSnapshot(snapshot: SessionSnapshot): void {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}
