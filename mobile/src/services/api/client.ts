import type { StoredCredentials } from '../../native/NativeCredentials';
import type { CredentialsStore } from '../credentials';
import type {
  ErrorPayload,
  Folder,
  HealthResponse,
  MobileLoginInput,
  MobileSessionResponse,
  PhotoPage,
  User,
} from './types';

export type ApiTransport = (url: string, init?: RequestInit) => Promise<Response>;

export type { CredentialsStore } from '../credentials';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId = '',
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: HeadersInit_;
  signal?: AbortSignal;
  auth?: boolean;
  retryOnUnauthorized?: boolean;
};

export type ListPhotosOptions = {
  folderId?: string;
  cursor?: string;
  limit?: number;
};

export type ApiClientOptions = {
  baseURL: string;
  serverId?: string;
  transport?: ApiTransport;
  credentials: CredentialsStore;
};

export type ApiClient = ReturnType<typeof createApiClient>;

const MOBILE_LOGIN_PATH = '/api/v1/mobile/auth/login';
const MOBILE_REFRESH_PATH = '/api/v1/mobile/auth/refresh';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isDateString(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function isUser(value: unknown): value is User {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.username) &&
    (value.role === 'admin' || value.role === 'user') &&
    typeof value.is_active === 'boolean' &&
    isDateString(value.created_at) &&
    isDateString(value.updated_at)
  );
}

function isMobileDevice(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.user_id) &&
    isNonEmptyString(value.name) &&
    (value.platform === 'android' || value.platform === 'ios') &&
    isNonEmptyString(value.app_version) &&
    isDateString(value.created_at) &&
    isDateString(value.last_seen_at)
  );
}

function parseSession(payload: unknown, requestId = ''): MobileSessionResponse {
  if (
    !isRecord(payload) ||
    !isNonEmptyString(payload.access_token) ||
    !isDateString(payload.access_token_expires_at) ||
    !isNonEmptyString(payload.refresh_token) ||
    !isDateString(payload.refresh_token_expires_at) ||
    !isMobileDevice(payload.device) ||
    !isUser(payload.user)
  ) {
    throw new ApiError(502, 'INVALID_RESPONSE', 'server returned an invalid mobile session', requestId);
  }
  return payload as unknown as MobileSessionResponse;
}

function credentialsFromSession(serverId: string, session: MobileSessionResponse): StoredCredentials {
  return {
    serverId,
    deviceId: session.device.id,
    accessToken: session.access_token,
    accessTokenExpiresAt: session.access_token_expires_at,
    refreshToken: session.refresh_token,
    refreshTokenExpiresAt: session.refresh_token_expires_at,
  };
}

async function readJSON(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function errorFromResponse(response: Response, payload: unknown): ApiError {
  const error = isRecord(payload) && isRecord(payload.error) ? (payload as ErrorPayload).error : undefined;
  const requestId = error?.request_id ?? response.headers.get('X-Request-ID') ?? '';
  return new ApiError(
    response.status,
    error?.code ?? 'REQUEST_FAILED',
    error?.message ?? 'Request failed',
    requestId,
    error?.details,
  );
}

function joinURL(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function createApiClient(options: ApiClientOptions) {
  let activeServerId = options.serverId ?? 'default';
  const transport = options.transport ?? ((url, init) => fetch(url, init));
  const baseURL = options.baseURL.replace(/\/+$/, '');

  let loadedCredentials: StoredCredentials | null | undefined;
  let credentialsLoad: Promise<StoredCredentials | null> | null = null;
  let refreshPromise: Promise<MobileSessionResponse> | null = null;

  const getCredentials = async (): Promise<StoredCredentials | null> => {
    if (loadedCredentials !== undefined) {
      return loadedCredentials;
    }
    if (!credentialsLoad) {
      credentialsLoad = options.credentials.get(activeServerId).then((value) => {
        loadedCredentials = value;
        if (!options.serverId && value?.serverId) {
          activeServerId = value.serverId;
        }
        credentialsLoad = null;
        return value;
      });
    }
    return credentialsLoad;
  };

  const requestOnce = async (path: string, requestOptions: RequestOptions): Promise<Response> => {
    const headers = new Headers(requestOptions.headers);
    headers.set('Accept', 'application/json');

    if (requestOptions.auth !== false) {
      const stored = await getCredentials();
      if (stored?.accessToken) {
        headers.set('Authorization', `Bearer ${stored.accessToken}`);
      }
    }

    const init: RequestInit = {
      method: (requestOptions.method ?? 'GET').toUpperCase(),
      headers,
      signal: requestOptions.signal,
    };
    if (requestOptions.body !== undefined) {
      init.body = typeof requestOptions.body === 'string' ? requestOptions.body : JSON.stringify(requestOptions.body);
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
    }
    return transport(joinURL(baseURL, path), init);
  };

  const requestJSON = async <T>(path: string, requestOptions: RequestOptions = {}): Promise<T> => {
    const response = await requestOnce(path, requestOptions);
    if (response.status === 401 && requestOptions.auth !== false && requestOptions.retryOnUnauthorized !== false) {
      await refreshSingleFlight();
      return requestJSON<T>(path, { ...requestOptions, retryOnUnauthorized: false });
    }
    const payload = await readJSON(response);
    if (!response.ok) {
      throw errorFromResponse(response, payload);
    }
    return payload as T;
  };

  const performRefresh = async (): Promise<MobileSessionResponse> => {
    const current = await getCredentials();
    if (!current?.refreshToken) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'authentication required');
    }
    const response = await requestOnce(MOBILE_REFRESH_PATH, {
      method: 'POST',
      body: { refresh_token: current.refreshToken },
      auth: false,
    });
    const payload = await readJSON(response);
    if (!response.ok) {
      throw errorFromResponse(response, payload);
    }
    const requestId = response.headers.get('X-Request-ID') ?? '';
    const session = parseSession(payload, requestId);
    const nextCredentials = credentialsFromSession(activeServerId, session);
    await options.credentials.set(nextCredentials);
    loadedCredentials = nextCredentials;
    return session;
  };

  const refreshSingleFlight = (): Promise<MobileSessionResponse> => {
    if (!refreshPromise) {
      refreshPromise = performRefresh()
        .catch(async (error: unknown) => {
          loadedCredentials = null;
          try {
            await options.credentials.clear(activeServerId);
          } catch {
            // Preserve the original authentication error if secure storage is unavailable.
          }
          throw error;
        })
        .finally(() => {
          refreshPromise = null;
        });
    }
    return refreshPromise;
  };

  const login = async (input: MobileLoginInput): Promise<MobileSessionResponse> => {
    const response = await requestOnce(MOBILE_LOGIN_PATH, {
      method: 'POST',
      body: {
        username: input.username,
        password: input.password,
        device_name: input.deviceName,
        platform: input.platform,
        app_version: input.appVersion,
      },
      auth: false,
    });
    const payload = await readJSON(response);
    if (!response.ok) {
      throw errorFromResponse(response, payload);
    }
    const requestId = response.headers.get('X-Request-ID') ?? '';
    const session = parseSession(payload, requestId);
    const nextCredentials = credentialsFromSession(activeServerId, session);
    await options.credentials.set(nextCredentials);
    loadedCredentials = nextCredentials;
    return session;
  };

  const refresh = (): Promise<MobileSessionResponse> => refreshSingleFlight();

  return {
    request: requestJSON,
    healthz: () => requestJSON<HealthResponse>('/healthz', { auth: false }),
    login,
    refresh,
    me: () => requestJSON<User>('/api/v1/auth/me'),
    logout: async (): Promise<void> => {
      await requestJSON<void>('/api/v1/mobile/auth/logout', { method: 'POST' });
      loadedCredentials = null;
      await options.credentials.clear(activeServerId);
    },
    listPhotos: (query: ListPhotosOptions = {}): Promise<PhotoPage> => {
      const params = new URLSearchParams();
      if (query.folderId) params.set('folder_id', query.folderId);
      if (query.cursor) params.set('cursor', query.cursor);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      const suffix = params.toString();
      return requestJSON<PhotoPage>(`/api/v1/photos${suffix ? `?${suffix}` : ''}`);
    },
    listFolders: (parentId?: string): Promise<{ items: Folder[] }> => {
      const suffix = parentId ? `?parent_id=${encodeURIComponent(parentId)}` : '';
      return requestJSON<{ items: Folder[] }>(`/api/v1/folders${suffix}`);
    },
  };
}
