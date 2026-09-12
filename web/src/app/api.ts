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

export interface Folder {
  id: string;
  owner_id: string;
  parent_id?: string | null;
  name: string;
  is_shared: boolean;
  photo_count?: number;
  child_folder_count?: number;
}

export interface Photo {
  id: string;
  owner_id: string;
  folder_id: string;
  filename: string;
  mime_type: string;
  size: number;
  width?: number;
  height?: number;
  captured_at: string;
  captured_at_source: string;
  source_revision?: string;
}

export interface PhotoPage {
  items: Photo[];
  next_cursor: string | null;
}

export interface UploadProgress {
  loaded: number;
  total: number;
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
  listPhotos(params?: { folderId?: string; cursor?: string; limit?: number }): Promise<PhotoPage>;
  listFolders(parentId?: string): Promise<{ items: Folder[] }>;
  createFolder(name: string, parentId?: string | null): Promise<Folder>;
  uploadPhoto(file: File, folderId: string, onProgress?: (progress: UploadProgress) => void, signal?: AbortSignal): Promise<Photo>;
  renamePhoto(id: string, name: string, conflict?: 'reject' | 'rename'): Promise<Photo>;
  movePhoto(id: string, folderId: string, conflict?: 'reject' | 'rename'): Promise<Photo>;
  deletePhoto(id: string): Promise<void>;
}

type Fetcher = typeof fetch;

export function createApiClient(fetcher: Fetcher = fetch): ApiClient {
  let csrfToken: string | null = null;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T | undefined> {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
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
    listPhotos: (params = {}) => {
      const query = new URLSearchParams();
      if (params.folderId) query.set('folder_id', params.folderId);
      if (params.cursor) query.set('cursor', params.cursor);
      if (params.limit) query.set('limit', String(params.limit));
      const suffix = query.toString();
      return request<PhotoPage>(`/api/v1/photos${suffix ? `?${suffix}` : ''}`) as Promise<PhotoPage>;
    },
    listFolders: (parentId) => {
      const suffix = parentId ? `?parent_id=${encodeURIComponent(parentId)}` : '';
      return request<{ items: Folder[] }>(`/api/v1/folders${suffix}`) as Promise<{ items: Folder[] }>;
    },
    createFolder: (name, parentId = null) => request<Folder>('/api/v1/folders', { method: 'POST', body: JSON.stringify({ name, parent_id: parentId }) }) as Promise<Folder>,
    uploadPhoto: (file, folderId, onProgress, signal) => new Promise<Photo>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', '/api/v1/photos/upload');
      request.withCredentials = true;
      if (csrfToken) request.setRequestHeader('X-CSRF-Token', csrfToken);
      request.upload.onprogress = (event) => onProgress?.({ loaded: event.loaded, total: event.total });
      request.onerror = () => reject(new ApiError(0, 'NETWORK_ERROR', 'Network request failed'));
      request.onabort = () => reject(new ApiError(0, 'ABORTED', 'Upload cancelled'));
      signal?.addEventListener('abort', () => request.abort(), { once: true });
      request.onload = () => {
        let payload: { error?: { code?: string; message?: string; request_id?: string } } & Partial<Photo> = {};
        try { payload = JSON.parse(request.responseText) as typeof payload; } catch { /* handled below */ }
        if (request.status < 200 || request.status >= 300) {
          const error = payload.error ?? {};
          reject(new ApiError(request.status, error.code ?? 'REQUEST_FAILED', error.message ?? 'Upload failed', error.request_id ?? ''));
          return;
        }
        resolve(payload as Photo);
      };
      const form = new FormData();
      form.set('folder_id', folderId);
      form.set('file', file, file.name);
      request.send(form);
    }),
    renamePhoto: (id, name, conflict = 'reject') => request<Photo>(`/api/v1/photos/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name, conflict }) }) as Promise<Photo>,
    movePhoto: (id, folderId, conflict = 'reject') => request<Photo>(`/api/v1/photos/${encodeURIComponent(id)}/move`, { method: 'POST', body: JSON.stringify({ target_folder_id: folderId, conflict }) }) as Promise<Photo>,
    deletePhoto: async (id) => { await request(`/api/v1/photos/${encodeURIComponent(id)}?confirm=true`, { method: 'DELETE' }); },
  };
}
