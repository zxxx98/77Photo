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
  is_live_photo?: boolean;
}

export interface PhotoPage {
  items: Photo[];
  next_cursor: string | null;
}

export interface BulkDeleteFailure {
  id: string;
  code: string;
}

export interface BulkDeleteResult {
  deleted_ids: string[];
  failed: BulkDeleteFailure[];
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

export interface Share {
  id: string;
  resource_type: 'folder';
  resource_id: string;
  user_id: string;
  permission: 'read' | 'write';
  created_at: string;
}

export type ShareResourceType = 'photo' | 'folder';
export type ShareDuration = '1_day' | '7_days' | 'forever';

export interface ShareLink {
  id: string;
  resource_type: ShareResourceType;
  resource_id: string;
  url: string;
  expires_at?: string | null;
  password_protected: boolean;
}

export interface PublicShare {
  resource_type: ShareResourceType;
  name: string;
  folder_name?: string;
  folder_path?: string;
  password_required: boolean;
  expires_at?: string | null;
}

export interface PublicPhoto {
  id: string;
  folder_id: string;
  filename: string;
  mime_type: string;
  size: number;
  captured_at: string;
  width?: number;
  height?: number;
}

export type RescanStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface RescanCounts {
  scanned: number;
  added: number;
  updated: number;
  missing: number;
  failed: number;
}

export interface RescanJob {
  id: string;
  status: RescanStatus;
  started_at: string;
  finished_at?: string;
  counts: RescanCounts;
  error?: string;
}

export type ThumbnailRebuildMode = 'full' | 'incremental';

export interface ThumbnailRebuildCounts {
  total: number;
  processed: number;
  regenerated: number;
  failed: number;
}

export interface ThumbnailRebuildJob {
  id: string;
  mode: ThumbnailRebuildMode;
  status: RescanStatus;
  started_at: string;
  finished_at?: string;
  counts: ThumbnailRebuildCounts;
  error?: string;
}

export interface BrokenPhoto {
  id: string;
  filename: string;
  reason: 'missing' | 'empty';
}

export interface BrokenPhotoScanResult {
  scanned: number;
  broken: number;
  items: BrokenPhoto[];
}

export interface BrokenPhotoCleanupResult {
  scanned: number;
  found: number;
  deleted: number;
  failed: number;
  failures: Array<{ id: string; code: string }>;
}

export interface ImportCounts {
  scanned: number;
  moved: number;
  skipped: number;
  failed: number;
}

export interface ImportJob {
  id: string;
  status: RescanStatus;
  source_path: string;
  user_id: string;
  started_at: string;
  finished_at?: string;
  counts: ImportCounts;
  error?: string;
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
  setupStatus(): Promise<{ required: boolean }>;
  setupAdmin(username: string, password: string): Promise<AuthResponse>;
  login(username: string, password: string): Promise<AuthResponse>;
  me(): Promise<User>;
  logout(): Promise<void>;
  setCsrfToken(token: string | null): void;
  listPhotos(params?: { folderId?: string; cursor?: string; limit?: number }): Promise<PhotoPage>;
  listFolders(parentId?: string): Promise<{ items: Folder[] }>;
  getFolder(id: string): Promise<Folder>;
  createFolder(name: string, parentId?: string | null): Promise<Folder>;
  uploadPhoto(file: File, folderId: string, onProgress?: (progress: UploadProgress) => void, signal?: AbortSignal): Promise<Photo>;
  uploadLivePhoto(file: File, motion: File, folderId: string, onProgress?: (progress: UploadProgress) => void, signal?: AbortSignal): Promise<Photo>;
  uploadLivePhotoMotion(photoId: string, file: File, onProgress?: (progress: UploadProgress) => void, signal?: AbortSignal): Promise<void>;
  renamePhoto(id: string, name: string, conflict?: 'reject' | 'rename'): Promise<Photo>;
  movePhoto(id: string, folderId: string, conflict?: 'reject' | 'rename'): Promise<Photo>;
  deletePhoto(id: string): Promise<void>;
  deletePhotos?(ids: string[]): Promise<BulkDeleteResult>;
  listShares(): Promise<{ items: Share[] }>;
  createShare(input: { folder_id: string; user_id: string; permission: 'read' | 'write' }): Promise<Share>;
  revokeShare(id: string): Promise<void>;
  createShareLink(input: { resource_type: ShareResourceType; resource_id: string; duration: ShareDuration; password?: string }): Promise<ShareLink>;
  getPublicShare(token: string): Promise<PublicShare>;
  unlockPublicShare(token: string, password: string): Promise<PublicShare>;
  listPublicSharePhotos(token: string): Promise<{ items: PublicPhoto[] }>;
  publicSharePreviewURL(token: string, photoID: string): string;
  listUsers(): Promise<{ items: User[] }>;
  createUser(input: { username: string; password: string; role: Role }): Promise<User>;
  updateUser(id: string, input: Partial<Pick<User, 'username' | 'role' | 'is_active'>> & { password?: string }): Promise<User>;
  deleteUser(id: string): Promise<void>;
  startRescan(): Promise<RescanJob>;
  resetLibraryIndex(): Promise<RescanJob>;
  getRescan(id: string): Promise<RescanJob>;
  startThumbnailRebuild(mode?: ThumbnailRebuildMode): Promise<ThumbnailRebuildJob>;
  getThumbnailRebuild(id: string): Promise<ThumbnailRebuildJob>;
  scanBrokenPhotos(): Promise<BrokenPhotoScanResult>;
  cleanupBrokenPhotos(): Promise<BrokenPhotoCleanupResult>;
  startImport(input: { source_path: string; user_id: string }): Promise<ImportJob>;
  getImport(id: string): Promise<ImportJob>;
}

type Fetcher = typeof fetch;

const liveStatusBatchSize = 100;

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
    const responseCsrfToken = response.headers.get('X-CSRF-Token');
    if (responseCsrfToken) csrfToken = responseCsrfToken;
    if (response.status === 204) return undefined;
    return response.json() as Promise<T>;
  }

  function uploadLiveMotion(photoId: string, file: File, onProgress?: (progress: UploadProgress) => void, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/v1/live-photos/${encodeURIComponent(photoId)}`);
      xhr.withCredentials = true;
      if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);
      xhr.upload.onprogress = (event) => onProgress?.({ loaded: event.loaded, total: event.total });
      xhr.onerror = () => reject(new ApiError(0, 'NETWORK_ERROR', 'Network request failed'));
      xhr.onabort = () => reject(new ApiError(0, 'ABORTED', 'Upload cancelled'));
      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
          return;
        }
        let payload: { error?: { code?: string; message?: string; request_id?: string } } = {};
        try { payload = JSON.parse(xhr.responseText) as typeof payload; } catch { /* handled below */ }
        const error = payload.error ?? {};
        reject(new ApiError(xhr.status, error.code ?? 'REQUEST_FAILED', error.message ?? 'Live Photo upload failed', error.request_id ?? ''));
      };
      const form = new FormData();
      form.set('file', file, file.name);
      xhr.send(form);
    });
  }

  function uploadLivePhoto(file: File, motion: File, folderId: string, onProgress?: (progress: UploadProgress) => void, signal?: AbortSignal): Promise<Photo> {
    return new Promise<Photo>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/v1/photos/live-upload');
      xhr.withCredentials = true;
      if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);
      xhr.upload.onprogress = (event) => onProgress?.({ loaded: event.loaded, total: event.total });
      xhr.onerror = () => reject(new ApiError(0, 'NETWORK_ERROR', 'Network request failed'));
      xhr.onabort = () => reject(new ApiError(0, 'ABORTED', 'Upload cancelled'));
      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.onload = () => {
        let payload: { error?: { code?: string; message?: string; request_id?: string } } & Partial<Photo> = {};
        try { payload = JSON.parse(xhr.responseText) as typeof payload; } catch { /* handled below */ }
        if (xhr.status < 200 || xhr.status >= 300) {
          const error = payload.error ?? {};
          reject(new ApiError(xhr.status, error.code ?? 'REQUEST_FAILED', error.message ?? 'Live Photo upload failed', error.request_id ?? ''));
          return;
        }
        resolve(payload as Photo);
      };
      const form = new FormData();
      form.append('folder_id', folderId);
      form.append('conflict', 'reject');
      if (file.lastModified > 0) form.append('file_modified_at', new Date(file.lastModified).toISOString());
      form.append('file', file, file.name);
      form.append('motion', motion, motion.name);
      xhr.send(form);
    });
  }

  return {
    setupStatus: () => request<{ required: boolean }>('/api/v1/setup/status') as Promise<{ required: boolean }>,
    setupAdmin: (username, password) => request<AuthResponse>('/api/v1/setup/admin', { method: 'POST', body: JSON.stringify({ username, password }) }) as Promise<AuthResponse>,
    login: (username, password) => request<AuthResponse>('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }) as Promise<AuthResponse>,
    me: () => request<User>('/api/v1/auth/me') as Promise<User>,
    logout: async () => { await request('/api/v1/auth/logout', { method: 'POST' }); },
    setCsrfToken: (token) => { csrfToken = token; },
    listPhotos: async (params = {}) => {
      const query = new URLSearchParams();
      if (params.folderId) query.set('folder_id', params.folderId);
      if (params.cursor) query.set('cursor', params.cursor);
      if (params.limit) query.set('limit', String(params.limit));
      const suffix = query.toString();
      const page = await request<PhotoPage>(`/api/v1/photos${suffix ? `?${suffix}` : ''}`) as PhotoPage;
      if (page.items.length === 0) return page;
      try {
        const liveIds = new Set<string>();
        for (let offset = 0; offset < page.items.length; offset += liveStatusBatchSize) {
          const ids = page.items.slice(offset, offset + liveStatusBatchSize).map((photo) => photo.id).join(',');
          const status = await request<{ live_photo_ids: string[] }>(`/api/v1/live-photos/status?ids=${encodeURIComponent(ids)}`);
          for (const id of status?.live_photo_ids ?? []) liveIds.add(id);
        }
        return { ...page, items: page.items.map((photo) => ({ ...photo, is_live_photo: liveIds.has(photo.id) })) };
      } catch {
        return page;
      }
    },
    listFolders: (parentId) => {
      const suffix = parentId ? `?parent_id=${encodeURIComponent(parentId)}` : '';
      return request<{ items: Folder[] }>(`/api/v1/folders${suffix}`) as Promise<{ items: Folder[] }>;
    },
    getFolder: (id) => request<Folder>(`/api/v1/folders/${encodeURIComponent(id)}`) as Promise<Folder>,
    createFolder: (name, parentId = null) => request<Folder>('/api/v1/folders', { method: 'POST', body: JSON.stringify({ name, parent_id: parentId }) }) as Promise<Folder>,
    uploadPhoto: (file, folderId, onProgress, signal) => new Promise<Photo>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/v1/photos/upload');
      xhr.withCredentials = true;
      if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);
      xhr.upload.onprogress = (event) => onProgress?.({ loaded: event.loaded, total: event.total });
      xhr.onerror = () => reject(new ApiError(0, 'NETWORK_ERROR', 'Network request failed'));
      xhr.onabort = () => reject(new ApiError(0, 'ABORTED', 'Upload cancelled'));
      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.onload = () => {
        let payload: { error?: { code?: string; message?: string; request_id?: string } } & Partial<Photo> = {};
        try { payload = JSON.parse(xhr.responseText) as typeof payload; } catch { /* handled below */ }
        if (xhr.status < 200 || xhr.status >= 300) {
          const error = payload.error ?? {};
          reject(new ApiError(xhr.status, error.code ?? 'REQUEST_FAILED', error.message ?? 'Upload failed', error.request_id ?? ''));
          return;
        }
        resolve(payload as Photo);
      };
      const form = new FormData();
      form.set('folder_id', folderId);
      if (file.lastModified > 0) form.set('file_modified_at', new Date(file.lastModified).toISOString());
      form.set('file', file, file.name);
      xhr.send(form);
    }),
    uploadLivePhoto: (file, motion, folderId, onProgress, signal) => uploadLivePhoto(file, motion, folderId, onProgress, signal),
    uploadLivePhotoMotion: (photoId, file, onProgress, signal) => uploadLiveMotion(photoId, file, onProgress, signal),
    renamePhoto: (id, name, conflict = 'reject') => request<Photo>(`/api/v1/photos/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name, conflict }) }) as Promise<Photo>,
    movePhoto: (id, folderId, conflict = 'reject') => request<Photo>(`/api/v1/photos/${encodeURIComponent(id)}/move`, { method: 'POST', body: JSON.stringify({ target_folder_id: folderId, conflict }) }) as Promise<Photo>,
    deletePhoto: async (id) => {
      await request(`/api/v1/live-photos/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await request(`/api/v1/photos/${encodeURIComponent(id)}?confirm=true`, { method: 'DELETE' });
    },
    deletePhotos: (ids) => request<BulkDeleteResult>('/api/v1/photos/batch-delete', { method: 'POST', body: JSON.stringify({ ids, confirm: true }) }) as Promise<BulkDeleteResult>,
    listShares: () => request<{ items: Share[] }>('/api/v1/shares') as Promise<{ items: Share[] }>,
    createShare: (input) => request<Share>('/api/v1/shares', { method: 'POST', body: JSON.stringify(input) }) as Promise<Share>,
    revokeShare: async (id) => { await request(`/api/v1/shares/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
    createShareLink: (input) => request<ShareLink>('/api/v1/share-links', { method: 'POST', body: JSON.stringify(input) }) as Promise<ShareLink>,
    getPublicShare: (token) => request<PublicShare>(`/api/v1/share-links/${encodeURIComponent(token)}`) as Promise<PublicShare>,
    unlockPublicShare: (token, password) => request<PublicShare>(`/api/v1/share-links/${encodeURIComponent(token)}/unlock`, { method: 'POST', body: JSON.stringify({ password }) }) as Promise<PublicShare>,
    listPublicSharePhotos: (token) => request<{ items: PublicPhoto[] }>(`/api/v1/share-links/${encodeURIComponent(token)}/photos`) as Promise<{ items: PublicPhoto[] }>,
    publicSharePreviewURL: (token, photoID) => `/api/v1/share-links/${encodeURIComponent(token)}/photos/${encodeURIComponent(photoID)}/preview`,
    listUsers: () => request<{ items: User[] }>('/api/v1/users') as Promise<{ items: User[] }>,
    createUser: (input) => request<User>('/api/v1/users', { method: 'POST', body: JSON.stringify(input) }) as Promise<User>,
    updateUser: (id, input) => request<User>(`/api/v1/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }) as Promise<User>,
    deleteUser: async (id) => { await request(`/api/v1/users/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ photo_action: 'retain' }) }); },
    startRescan: () => request<RescanJob>('/api/v1/admin/rescan', { method: 'POST', body: JSON.stringify({}) }) as Promise<RescanJob>,
    resetLibraryIndex: () => request<RescanJob>('/api/v1/admin/rescan/reset', { method: 'POST', body: JSON.stringify({ confirm: true }) }) as Promise<RescanJob>,
    getRescan: (id) => request<RescanJob>(`/api/v1/admin/rescan/${encodeURIComponent(id)}`) as Promise<RescanJob>,
    startThumbnailRebuild: (mode = 'full') => request<ThumbnailRebuildJob>('/api/v1/admin/thumbnails/rebuild', { method: 'POST', body: JSON.stringify({ mode }) }) as Promise<ThumbnailRebuildJob>,
    getThumbnailRebuild: (id) => request<ThumbnailRebuildJob>(`/api/v1/admin/thumbnails/rebuild/${encodeURIComponent(id)}`) as Promise<ThumbnailRebuildJob>,
    scanBrokenPhotos: () => request<BrokenPhotoScanResult>('/api/v1/admin/photos/cleanup') as Promise<BrokenPhotoScanResult>,
    cleanupBrokenPhotos: () => request<BrokenPhotoCleanupResult>('/api/v1/admin/photos/cleanup', { method: 'POST', body: JSON.stringify({ confirm: true }) }) as Promise<BrokenPhotoCleanupResult>,
    startImport: (input) => request<ImportJob>('/api/v1/admin/imports', { method: 'POST', body: JSON.stringify(input) }) as Promise<ImportJob>,
    getImport: (id) => request<ImportJob>(`/api/v1/admin/imports/${encodeURIComponent(id)}`) as Promise<ImportJob>,
  };
}
