import type { StoredCredentials } from '../../native/NativeCredentials';
import NativeDownload from '../../native/NativeDownload';
import { assertRedirectAllowed, evaluateServerURL } from '../connection/policy';
import type { CredentialsStore } from '../credentials';
import type {
  CreateShareLinkInput,
  ErrorPayload,
  Folder,
  FolderPage,
  HealthResponse,
  MobileLoginInput,
  MobileSessionResponse,
  Photo,
  PhotoPage,
  RescanJob,
  ShareLink,
  ThumbnailSize,
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
  signal?: AbortSignal;
};

export type ApiClientOptions = {
  baseURL: string;
  serverId?: string;
  transport?: ApiTransport;
  credentials: CredentialsStore;
  userId?: string;
  lanCIDRs?: readonly string[] | (() => readonly string[]);
  queryClient?: {
    removeQueries: (filters?: { predicate?: (query: { queryKey: readonly unknown[] }) => boolean }) => unknown;
  };
  onSessionCleared?: () => void | Promise<void>;
};

export type ApiClient = ReturnType<typeof createApiClient>;

export type AuthenticatedImageContextListener = () => void;
const authenticatedImageContextListeners = new Set<AuthenticatedImageContextListener>();

export function subscribeAuthenticatedImageContext(listener: AuthenticatedImageContextListener): () => void {
  authenticatedImageContextListeners.add(listener);
  return () => authenticatedImageContextListeners.delete(listener);
}

export function clearAuthenticatedImageContext(): void {
  for (const listener of authenticatedImageContextListeners) listener();
}

export function clearSessionQueries(
  queryClient: ApiClientOptions['queryClient'] | undefined,
  serverId: string,
  userId?: string,
): void {
  queryClient?.removeQueries({
    predicate: ({ queryKey }) => {
      const isScopedFeature = queryKey[0] === 'photos' || queryKey[0] === 'folders';
      return isScopedFeature && queryKey[1] === serverId && (userId === undefined || queryKey[2] === userId);
    },
  });
  clearAuthenticatedImageContext();
}

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

function guardedMediaURL(
  baseURL: string,
  path: string,
  lanCIDRs: readonly string[],
): string {
  const url = joinURL(baseURL, path);
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return '';
    const decision = evaluateServerURL(`${parsed.protocol}//${parsed.host}`, lanCIDRs);
    return decision.allowed ? url : '';
  } catch {
    return '';
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

async function requestWithPolicyRedirects(
  transport: ApiTransport,
  url: string,
  init: RequestInit,
  lanCIDRs: readonly string[],
): Promise<Response> {
  let currentURL = new URL(url);
  if (currentURL.username || currentURL.password) {
    throw new Error('server_invalid_url');
  }
  const initialDecision = evaluateServerURL(
    `${currentURL.protocol}//${currentURL.host}`,
    lanCIDRs,
  );
  if (!initialDecision.allowed) {
    throw new Error(`server_${initialDecision.reason}`);
  }
  let currentInit = { ...init, redirect: 'manual' as const };

  for (let redirectCount = 0; ; redirectCount += 1) {
    const response = await transport(currentURL.toString(), currentInit);
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get('Location');
    if (!location) return response;
    if (redirectCount >= MAX_REDIRECTS) throw new Error('redirect_limit');

    const nextURL = new URL(location, currentURL);
    assertRedirectAllowed(currentURL, nextURL, lanCIDRs);
    if ([301, 302, 303].includes(response.status) &&
      ['POST', 'PUT', 'PATCH'].includes((currentInit.method ?? 'GET').toUpperCase())) {
      currentInit = { ...currentInit, method: 'GET', body: undefined };
    }
    currentURL = nextURL;
  }
}

export function createApiClient(options: ApiClientOptions) {
  let activeServerId = options.serverId ?? 'default';
  const transport = options.transport ?? ((url, init) => fetch(url, init));
  const baseURL = options.baseURL.replace(/\/+$/, '');
  const getLANCIDRs = (): readonly string[] =>
    typeof options.lanCIDRs === 'function' ? options.lanCIDRs() : options.lanCIDRs ?? [];

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
    return requestWithPolicyRedirects(
      transport,
      joinURL(baseURL, path),
      init,
      getLANCIDRs(),
    );
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

  const clearSession = async (serverId = activeServerId, userId = options.userId): Promise<void> => {
    if (serverId === activeServerId) loadedCredentials = null;
    try {
      await options.credentials.clear(serverId);
    } finally {
      clearSessionQueries(options.queryClient, serverId, userId);
      await options.onSessionCleared?.();
    }
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
      try {
        await requestJSON<void>('/api/v1/mobile/auth/logout', { method: 'POST' });
      } finally {
        await clearSession();
      }
    },
    clearSession,
    getAuthHeaders: async (): Promise<Record<string, string>> => {
      const stored = await getCredentials();
      return stored?.accessToken ? { Authorization: `Bearer ${stored.accessToken}` } : {};
    },
    listPhotos: (query: ListPhotosOptions = {}): Promise<PhotoPage> => {
      const params = new URLSearchParams();
      if (query.folderId) params.set('folder_id', query.folderId);
      if (query.cursor) params.set('cursor', query.cursor);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      const suffix = params.toString();
      return requestJSON<PhotoPage>(`/api/v1/photos${suffix ? `?${suffix}` : ''}`, { signal: query.signal }).then(async (page) => {
        if (page.items.length === 0) return page;
        try {
          const ids = page.items.slice(0, 100).map((photo) => photo.id).join(',');
          const status = await requestJSON<{ live_photo_ids: string[] }>(
            `/api/v1/live-photos/status?ids=${encodeURIComponent(ids)}`,
            { signal: query.signal },
          );
          const liveIds = new Set(status.live_photo_ids);
          return {
            ...page,
            items: page.items.map((photo, index) => index < 100
              ? { ...photo, is_live_photo: liveIds.has(photo.id) }
              : photo),
          };
        } catch {
          // Status is an enhancement; an unavailable status endpoint must not hide the gallery.
          return page;
        }
      });
    },
    listFolders: (parentId?: string): Promise<FolderPage> => {
      const suffix = parentId ? `?parent_id=${encodeURIComponent(parentId)}` : '';
      return requestJSON<FolderPage>(`/api/v1/folders${suffix}`);
    },
    getFolder: (id: string): Promise<Folder> => requestJSON<Folder>(`/api/v1/folders/${encodeURIComponent(id)}`),
    getPhoto: (id: string): Promise<Photo> => requestJSON<Photo>(`/api/v1/photos/${encodeURIComponent(id)}`),
    thumbnailURL: (id: string, size: ThumbnailSize): string =>
      guardedMediaURL(baseURL, `/api/v1/photos/${encodeURIComponent(id)}/thumbnail?size=${size}`, getLANCIDRs()),
    previewURL: (id: string): string =>
      guardedMediaURL(baseURL, `/api/v1/photos/${encodeURIComponent(id)}/preview`, getLANCIDRs()),
    livePhotoURL: (id: string): string =>
      guardedMediaURL(baseURL, `/api/v1/live-photos/${encodeURIComponent(id)}`, getLANCIDRs()),
    originalURL: (id: string): string =>
      guardedMediaURL(baseURL, `/api/v1/photos/${encodeURIComponent(id)}/original`, getLANCIDRs()),
    downloadOriginal: async (id: string, fileName: string): Promise<void> => {
      const stored = await getCredentials();
      if (!stored?.accessToken) throw new ApiError(401, 'AUTH_REQUIRED', 'authentication required');
      if (!NativeDownload) throw new Error('NativeDownload is unavailable');
      const url = guardedMediaURL(baseURL, `/api/v1/photos/${encodeURIComponent(id)}/original`, getLANCIDRs());
      if (!url) throw new Error('server_media_url_blocked');
      await NativeDownload.download(
        url,
        fileName,
        `Bearer ${stored.accessToken}`,
        getLANCIDRs(),
      );
    },
    createShareLink: (input: CreateShareLinkInput): Promise<ShareLink> => requestJSON<ShareLink>('/api/v1/share-links', {
      method: 'POST',
      body: {
        resource_type: input.resourceType,
        resource_id: input.resourceId,
        duration: input.duration,
        ...(input.password ? { password: input.password } : {}),
      },
    }),
    deletePhoto: (id: string): Promise<void> =>
      requestJSON<void>(`/api/v1/photos/${encodeURIComponent(id)}?confirm=true`, { method: 'DELETE' }),
    startRescan: (): Promise<RescanJob> => requestJSON<RescanJob>('/api/v1/admin/rescan', {
      method: 'POST',
      body: {},
    }),
    getRescan: (id: string): Promise<RescanJob> =>
      requestJSON<RescanJob>(`/api/v1/admin/rescan/${encodeURIComponent(id)}`),
  };
}
