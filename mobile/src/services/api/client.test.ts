import type { StoredCredentials } from '../../native/NativeCredentials';
import type { ApiTransport, CredentialsStore } from './client';
import { ApiError, createApiClient } from './client';

type Call = { url: string; init: RequestInit };

const session = (accessToken: string, refreshToken: string) => ({
  access_token: accessToken,
  access_token_expires_at: '2026-09-15T12:15:00.000Z',
  refresh_token: refreshToken,
  refresh_token_expires_at: '2026-12-14T12:00:00.000Z',
  device: {
    id: 'device-1',
    user_id: 'user-1',
    name: 'Pixel 9',
    platform: 'android',
    app_version: '1.0.0',
    created_at: '2026-09-15T12:00:00.000Z',
    last_seen_at: '2026-09-15T12:00:00.000Z',
  },
  user: {
    id: 'user-1',
    username: 'admin',
    role: 'admin',
    is_active: true,
    created_at: '2026-09-15T12:00:00.000Z',
    updated_at: '2026-09-15T12:00:00.000Z',
  },
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function createScriptedTransport(options: {
  protected401Count?: number;
  alwaysProtected401?: boolean;
  refreshedToken?: string;
  refreshStatus?: number;
  errorBody?: unknown;
  errorHeaders?: Record<string, string>;
}) {
  const calls: Call[] = [];
  let remaining401 = options.protected401Count ?? 0;
  const transport: ApiTransport = async (url, init = {}) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    if (path === '/api/v1/mobile/auth/login') {
      return jsonResponse(session('access-login', 'refresh-login'));
    }
    if (path === '/api/v1/mobile/auth/refresh') {
      if (options.refreshStatus) {
        return jsonResponse(
          options.errorBody ?? { error: { code: 'AUTH_REQUIRED', message: 'authentication required' } },
          options.refreshStatus,
          options.errorHeaders,
        );
      }
      return jsonResponse(session(options.refreshedToken ?? 'access-2', 'refresh-2'));
    }
    if (path === '/api/v1/photos' || path === '/api/v1/folders') {
      if (options.alwaysProtected401 || remaining401 > 0) {
        remaining401 -= 1;
        return jsonResponse(
          options.errorBody ?? { error: { code: 'AUTH_REQUIRED', message: 'authentication required' } },
          401,
          options.errorHeaders,
        );
      }
      return jsonResponse(path.endsWith('photos') ? { items: [], next_cursor: null } : { items: [] });
    }
    return jsonResponse({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
  };

  return {
    transport,
    calls: (path: string) => calls.filter((call) => new URL(call.url).pathname === path),
    authorizationHeaders: () => calls.map((call) => new Headers(call.init.headers).get('Authorization')),
  };
}

function createMemoryCredentials(initial: StoredCredentials): CredentialsStore & { clear: jest.Mock } {
  let current: StoredCredentials | null = initial;
  return {
    get: jest.fn(async () => current),
    set: jest.fn(async (value: StoredCredentials) => {
      current = value;
    }),
    clear: jest.fn(async () => {
      current = null;
    }),
  };
}

const storedCredentials: StoredCredentials = {
  serverId: 'server-1',
  deviceId: 'device-1',
  accessToken: 'expired',
  accessTokenExpiresAt: '2026-09-15T12:15:00.000Z',
  refreshToken: 'refresh-1',
  refreshTokenExpiresAt: '2026-12-14T12:00:00.000Z',
};

describe('mobile API client', () => {
  it('performs one refresh for concurrent 401 responses', async () => {
    const scripted = createScriptedTransport({ protected401Count: 2, refreshedToken: 'access-2' });
    const credentials = createMemoryCredentials(storedCredentials);
    const client = createApiClient({
      baseURL: 'https://server.test',
      serverId: 'server-1',
      transport: scripted.transport,
      credentials,
    });

    await Promise.all([client.listPhotos(), client.listFolders()]);

    expect(scripted.calls('/api/v1/mobile/auth/refresh')).toHaveLength(1);
    expect(scripted.authorizationHeaders()).toContain('Bearer access-2');
    expect(credentials.set).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'access-2' }));
  });

  it('retries a failed request at most once', async () => {
    const scripted = createScriptedTransport({ alwaysProtected401: true });
    const client = createApiClient({
      baseURL: 'https://server.test',
      transport: scripted.transport,
      credentials: createMemoryCredentials(storedCredentials),
    });

    await expect(client.listPhotos()).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    expect(scripted.calls('/api/v1/photos')).toHaveLength(2);
    expect(scripted.calls('/api/v1/mobile/auth/refresh')).toHaveLength(1);
  });

  it('clears credentials when refresh fails', async () => {
    const scripted = createScriptedTransport({ refreshStatus: 401, protected401Count: 1 });
    const credentials = createMemoryCredentials(storedCredentials);
    const client = createApiClient({
      baseURL: 'https://server.test',
      transport: scripted.transport,
      credentials,
    });

    await expect(client.listPhotos()).rejects.toBeInstanceOf(ApiError);
    expect(credentials.clear).toHaveBeenCalledWith('server-1');
  });

  it('decodes JSON errors and retains the request ID', async () => {
    const scripted = createScriptedTransport({
      errorBody: {
        error: { code: 'READ_FORBIDDEN', message: 'read denied', request_id: 'req-body' },
      },
      errorHeaders: { 'X-Request-ID': 'req-header' },
      alwaysProtected401: true,
    });
    const client = createApiClient({
      baseURL: 'https://server.test',
      transport: scripted.transport,
      credentials: createMemoryCredentials(storedCredentials),
    });

    await expect(client.listPhotos()).rejects.toMatchObject({
      status: 401,
      code: 'READ_FORBIDDEN',
      message: 'read denied',
      requestId: 'req-body',
    });
  });

  it('does not attach Authorization to login or refresh', async () => {
    const scripted = createScriptedTransport({});
    const credentials = createMemoryCredentials(storedCredentials);
    const client = createApiClient({ baseURL: 'https://server.test', transport: scripted.transport, credentials });

    await client.login({
      username: 'admin',
      password: 'correct horse battery staple',
      deviceName: 'Pixel 9',
      platform: 'android',
      appVersion: '1.0.0',
    });
    await client.refresh();

    const authHeaders = scripted.authorizationHeaders();
    expect(authHeaders[0]).toBeNull();
    expect(authHeaders[1]).toBeNull();
  });
});
