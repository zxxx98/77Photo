export type Role = 'admin' | 'user';

export interface User {
  id: string;
  username: string;
  role: Role;
  is_active: boolean;
  deleted_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface AuthResponse {
  user: User;
  csrf_token: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;

  constructor(status: number, code: string, message: string, requestId = '') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export interface ApiClient {
  login(username: string, password: string): Promise<AuthResponse>;
  me(): Promise<User>;
  logout(): Promise<void>;
  setCsrfToken(token: string | null): void;
}

type Fetcher = typeof fetch;

export function createApiClient(fetcher: Fetcher = fetch): ApiClient {
  let csrfToken: string | null = null;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T | undefined> {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('X-CSRF-Token', csrfToken);
    const response = await fetcher(path, { ...init, method, headers, credentials: 'include' });
    if (!response.ok) {
      let payload: { error?: { code?: string; message?: string; request_id?: string } } = {};
      try { payload = await response.json(); } catch { /* non-JSON errors use a safe generic message */ }
      const error = payload.error ?? {};
      throw new ApiError(response.status, error.code ?? 'REQUEST_FAILED', error.message ?? 'Request failed', error.request_id ?? '');
    }
    if (response.status === 204) return undefined;
    return response.json() as Promise<T>;
  }

  return {
    login: (username, password) => request<AuthResponse>('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }) as Promise<AuthResponse>,
    me: () => request<User>('/api/v1/auth/me') as Promise<User>,
    logout: async () => { await request('/api/v1/auth/logout', { method: 'POST' }); },
    setCsrfToken: (token) => { csrfToken = token; },
  };
}
