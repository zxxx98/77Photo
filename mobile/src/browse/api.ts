import {ServerConnection, type ServerProfile} from '../auth/connection';
import {ApiError, refresh} from '../auth/api';
import {clearSession, saveSession, type MobileSession} from '../auth/session';

export type Photo = {
  id: string; owner_id: string; folder_id: string; filename: string; mime_type: string;
  size: number; captured_at: string; width?: number; height?: number;
  is_favorite?: boolean; gps_latitude?: number | null; gps_longitude?: number | null;
  focal_length?: number | null; aperture?: number | null; iso?: number | null;
  camera_make?: string | null; camera_model?: string | null; is_live_photo?: boolean;
};
export type Folder = {
  id: string; owner_id: string; parent_id: string | null; name: string;
  is_shared: boolean; inherited_permission?: 'read' | 'write' | null;
  effective_permission?: 'read' | 'write';
  photo_count?: number; child_folder_count?: number;
};
export type BBox = [west: number, south: number, east: number, north: number];
export type MapTileLayer = {url: string; subdomains: string};
export type MapConfig = {enabled: boolean; provider?: string; tile_layers?: MapTileLayer[]; min_zoom?: number; max_zoom?: number; attribution?: string; attribution_url?: string};
export type MapPoint = [id: string, latitude: number, longitude: number, capturedAt: string];
export type MapPoints = {items: MapPoint[]; total_photos: number};
export type Person = {id: string; owner_id: string; name: string; revision: number; photo_count: number; cover_face_id: string};
export type Face = {id: string; owner_id: string; photo_id: string; person_id: string; filename: string; revision: number; ignored: boolean};
export type FacePage<T> = {items: T[]; next_cursor: string};
export type FaceConfig = {enabled: boolean; configured: boolean};
export type PhotoFilters = {q?: string; mediaType?: '' | 'photo' | 'video'; from?: string; to?: string; bbox?: BBox};
export type BatchFailure = {id: string; code: string};
export type BatchResult = {completed_ids: string[]; failed: BatchFailure[]; has_more?: boolean};
export type TrashItem = {
  id: string; owner_id: string; filename: string; mime_type: string; size: number;
  folder_id: string; folder_name: string; deleted_at: string; expires_at: string;
  state: 'moving' | 'trashed' | 'restoring' | 'purging'; recovery_required: boolean;
};
export type TrashPage = {items: TrashItem[]; next_cursor: string | null; retention_days: number};
export type PhotoPage = {items: Photo[]; next_cursor: string | null; favorites_supported?: boolean};

export type LoadState = 'loading' | 'ready' | 'empty' | 'offline' | 'forbidden' | 'expired' | 'failed';

export function errorState(error: unknown): LoadState {
  if (error instanceof ApiError) {
    if (error.status === 401) {return 'expired';}
    if (error.status === 403) {return 'forbidden';}
  }
  if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) {return 'offline';}
  return 'failed';
}

export function groupPhotos(items: Photo[]): {date: string; items: Photo[]}[] {
  const groups = new Map<string, Photo[]>();
  for (const photo of items) {
    const date = photo.captured_at.slice(0, 10);
    groups.set(date, [...(groups.get(date) ?? []), photo]);
  }
  return [...groups].sort(([a], [b]) => b.localeCompare(a)).map(([date, photos]) => ({date, items: photos}));
}

export class BrowseApi {
  private session: MobileSession;
  private refreshing: Promise<MobileSession> | null = null;
  readonly connection = new ServerConnection();
  private listeners = new Set<() => void>();
  private revision = 0;
  subscribe = (listener: () => void) => {this.listeners.add(listener); return () => {this.listeners.delete(listener);};};
  getRevision = () => this.revision;
  refreshBrowsing() {this.notifyConnection();}
  private notifyConnection() {this.revision++; this.listeners.forEach(listener => listener());}
  private reconnecting: Promise<MobileSession> | null = null;
  private reconnectedAt = 0;
  private saving: Promise<void> = Promise.resolve();
  constructor(session: MobileSession, private onSession: (session: MobileSession) => void) {
    this.session = session;
  }

  private async commit(next: MobileSession) {
    const changedAddress = this.session.server !== next.server;
    this.session = next;
    this.saving = this.saving.catch(() => {}).then(() => saveSession(next));
    await this.saving;
    if (this.session === next) {this.onSession(next); if (changedAddress) {this.notifyConnection();}}
  }

  async updateProfile(profile: ServerProfile) {
    if (this.refreshing) {await this.refreshing;}
    this.connection.invalidate();
    this.reconnecting = null;
    this.reconnectedAt = 0;
    await this.commit({...this.session, profile});
  }

  async reconnect(force = false): Promise<MobileSession> {
    if (this.reconnecting) {return this.reconnecting;}
    if (!force && Date.now() - this.reconnectedAt < 3000) {return this.connectedSession();}
    this.connection.invalidate();
    const previous = this.session.server;
    const pending = this.connectedSession().then(next => {
      this.reconnectedAt = Date.now();
      if (previous === next.server) {this.notifyConnection();}
      return next;
    }).finally(() => {if (this.reconnecting === pending) {this.reconnecting = null;}});
    this.reconnecting = pending;
    return pending;
  }

  private async connectedSession(): Promise<MobileSession> {
    const snapshot = this.session;
    const server = await this.connection.resolve(snapshot);
    if (snapshot.profile !== this.session.profile) {return this.connectedSession();}
    if (server !== this.session.server) {await this.commit({...this.session, server});}
    return this.session;
  }

  private async rotate(): Promise<MobileSession> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          const renewed = await refresh(this.session);
          const next = {...renewed, server: this.session.server, profile: this.session.profile};
          await this.commit(next);
          return next;
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) {await clearSession();}
          throw error;
        }
      })().finally(() => {this.refreshing = null;});
    }
    return this.refreshing;
  }

  async validSession(): Promise<MobileSession> {
    await this.connectedSession();
    const expiry = Date.parse(this.session.accessExpiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now() + 60_000) {return this.rotate();}
    return this.session;
  }

  async request<T>(path: string, retried = false, connectionRetried = false): Promise<T> {
    const session = await this.validSession();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let response: Response;
    try {
      response = await fetch(session.server + path, {
        headers: {Accept: 'application/json', Authorization: `Bearer ${session.accessToken}`},
        signal: controller.signal,
      });
    } catch (error) {
      // Only replay the GET itself. A failed refresh POST may already have
      // rotated the token pair and must never be retried by this fallback.
      if (!connectionRetried && this.session.profile?.publicKey &&
          (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError'))) {
        if (session.server === this.session.server) {await this.reconnect();}
        return this.request<T>(path, retried, true);
      }
      throw error;
    } finally {clearTimeout(timer);}
    if (response.status === 401 && !retried) {
      if (session.accessToken === this.session.accessToken) {await this.rotate();}
      return this.request<T>(path, true, connectionRetried);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new ApiError(response.status, body?.error?.code ?? '', body?.error?.message ?? '请求失败');
    }
    return await response.json() as T;
  }

  // Mutations retry only an explicit 401; a lost response is never replayed.
  async mutate<T>(path: string, method: string, input?: unknown, retried = false): Promise<T> {
    const session = await this.validSession();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    let response: Response;
    try {
      response = await fetch(session.server + path, {
        method, signal: controller.signal,
        headers: {Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}`},
        ...(input === undefined ? {} : {body: JSON.stringify(input)}),
      });
      if (response.status === 401 && !retried) {
        if (session.accessToken === this.session.accessToken) {await this.rotate();}
        return this.mutate<T>(path, method, input, true);
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new ApiError(response.status, body?.error?.code ?? '', body?.error?.message ?? '操作失败');
      }
      if (response.status === 204) {return undefined as T;}
      return await response.json() as T;
    } finally {clearTimeout(timer);}
  }
  setFavorite(id: string, favorite: boolean): Promise<void> {
    return this.mutate(`/api/v1/photos/${encodeURIComponent(id)}/favorite`, favorite ? 'PUT' : 'DELETE');
  }
  createFolder(name: string, parentId: string | null = null): Promise<Folder> {
    return this.mutate('/api/v1/folders', 'POST', {name, parent_id: parentId});
  }
  movePhoto(id: string, folderId: string, conflict: 'reject' | 'rename' = 'reject'): Promise<Photo> {
    return this.mutate(`/api/v1/photos/${encodeURIComponent(id)}/move`, 'POST', {target_folder_id: folderId, conflict});
  }
  deletePhotos(ids: string[]): Promise<{deleted_ids: string[]; failed: BatchFailure[]}> {
    return this.mutate('/api/v1/photos/batch-delete', 'POST', {ids, confirm: true});
  }
  listTrash(cursor?: string): Promise<TrashPage> {
    const params = new URLSearchParams({scope: 'mine'});
    if (cursor) {params.set('cursor', cursor);}
    return this.request(`/api/v1/trash/photos?${params}`);
  }
  restoreTrash(ids: string[], folderId?: string, rename = false): Promise<BatchResult> {
    return this.mutate('/api/v1/trash/photos/batch-restore', 'POST', {
      ids, ...(folderId ? {folder_id: folderId} : {}), conflict: rename ? 'rename' : 'reject',
    });
  }
  purgeTrash(ids: string[]): Promise<BatchResult> {
    return this.mutate('/api/v1/trash/photos/batch-delete', 'POST', {ids, confirm: true});
  }
  emptyTrash(before: string): Promise<BatchResult> {
    return this.mutate('/api/v1/trash/photos/empty', 'POST', {scope: 'mine', before, confirm: true});
  }
  retryTrash(id: string): Promise<void> {
    return this.mutate(`/api/v1/trash/photos/${encodeURIComponent(id)}/retry`, 'POST', {});
  }
  async trashPreview(id: string) {
    const session = await this.validSession();
    return {uri: `${session.server}/api/v1/trash/photos/${encodeURIComponent(id)}/preview`, headers: {Authorization: `Bearer ${session.accessToken}`}};
  }
  listPhotos(folderId?: string, cursor?: string, limit = 50, favorite = false, filters: PhotoFilters = {}): Promise<PhotoPage> {
    const params = new URLSearchParams({limit: String(limit)});
    if (folderId) {params.set('folder_id', folderId);}
    if (favorite) {params.set('favorite', 'true');}
    if (cursor) {params.set('cursor', cursor);}
    if (filters.bbox) {params.set('bbox', filters.bbox.join(','));}
    if (filters.q) {params.set('q', filters.q);}
    if (filters.mediaType) {params.set('media_type', filters.mediaType);}
    if (filters.from) {params.set('from', filters.from);}
    if (filters.to) {params.set('to', filters.to);}
    return this.request<PhotoPage>(`/api/v1/photos?${params}`);
  }
  async listFolders(parentId?: string): Promise<Folder[]> {
    const query = parentId ? `?parent_id=${encodeURIComponent(parentId)}` : '';
    const [listing, me, shares] = await Promise.all([
      this.request<{items: Folder[]}>(`/api/v1/folders${query}`),
      this.request<{id: string; role: string}>('/api/v1/auth/me'),
      this.request<{items: {resource_id: string; user_id: string; permission: 'read' | 'write'}[]}>('/api/v1/shares'),
    ]);
    const grants = shares.items.filter(share => share.user_id === me.id);
    // Recompute ancestor grants on each listing rather than trusting cached writes
    // after a share has been revoked or changed.
    const ancestorIds = new Set<string>();
    let ancestorId = parentId;
    while (ancestorId && !ancestorIds.has(ancestorId)) {
      ancestorIds.add(ancestorId);
      try {ancestorId = (await this.folder(ancestorId)).parent_id ?? undefined;}
      catch (error) {
        if (error instanceof ApiError && [403, 404].includes(error.status)) {break;}
        throw error;
      }
    }
    const inheritedWrite = grants.some(share => ancestorIds.has(share.resource_id) && share.permission === 'write');
    const decorate = (folder: Folder): Folder => {
      const permission = me.role === 'admin' || folder.owner_id === me.id ? 'write' :
        (inheritedWrite || folder.inherited_permission === 'write' || grants.some(share => share.resource_id === folder.id && share.permission === 'write')) ? 'write' : 'read';
      return {...folder, effective_permission: permission};
    };
    const own = listing.items.map(decorate);
    if (parentId) {return own;}
    const shared = await Promise.all(shares.items.filter(share => share.user_id === me.id)
      .map(async share => {
        try {
          const folder = await this.request<Folder>(`/api/v1/folders/${encodeURIComponent(share.resource_id)}`);
          return decorate({...folder, is_shared: true, inherited_permission: share.permission});
        } catch (error) {
          if (error instanceof ApiError && [403, 404].includes(error.status)) {return null;}
          throw error;
        }
      }));
    const seen = new Set(own.map(folder => folder.id));
    return [...own, ...shared.filter(folder => !!folder && !seen.has(folder.id)).map(folder => folder as Folder)];
  }
  async writableFolder(id: string): Promise<Folder> {
    const [folder, me, shares] = await Promise.all([
      this.folder(id), this.request<{id: string; role: string}>('/api/v1/auth/me'),
      this.request<{items: {resource_id: string; user_id: string; permission: string}[]}>('/api/v1/shares'),
    ]);
    let writable = me.role === 'admin' || folder.owner_id === me.id;
    let ancestor: Folder | null = folder;
    const seen = new Set<string>();
    while (!writable && ancestor && !seen.has(ancestor.id)) {
      seen.add(ancestor.id);
      writable = shares.items.some(share => share.user_id === me.id && share.resource_id === ancestor?.id && share.permission === 'write');
      if (writable || !ancestor.parent_id) {break;}
      try {ancestor = await this.folder(ancestor.parent_id);}
      catch (error) {
        if (error instanceof ApiError && [403, 404].includes(error.status)) {break;}
        throw error;
      }
    }
    return {...folder, effective_permission: writable ? 'write' : 'read'};
  }
  me(): Promise<{id: string; role: 'admin' | 'user'}> {return this.request('/api/v1/auth/me');}
  mapConfig(): Promise<MapConfig> {return this.request('/api/v1/map/config');}
  mapPoints(): Promise<MapPoints> {return this.request('/api/v1/map/points');}
  faceConfig(): Promise<FaceConfig> {return this.request('/api/v1/admin/faces/config');}
  people(cursor = ''): Promise<FacePage<Person>> {
    return this.request(`/api/v1/admin/people?cursor=${encodeURIComponent(cursor)}`);
  }
  personFaces(id: string, cursor = ''): Promise<FacePage<Face>> {
    return this.request(`/api/v1/admin/people/${encodeURIComponent(id)}/faces?cursor=${encodeURIComponent(cursor)}`);
  }
  renamePerson(person: Person, name: string): Promise<{ok: boolean}> {
    return this.mutate(`/api/v1/admin/people/${encodeURIComponent(person.id)}`, 'PATCH', {name, revision: person.revision});
  }
  async faceSource(id: string) {
    const session = await this.validSession();
    return {uri: `${session.server}/api/v1/admin/faces/${encodeURIComponent(id)}/thumbnail`, headers: {Authorization: `Bearer ${session.accessToken}`}};
  }
  photo(id: string): Promise<Photo> {return this.request<Photo>(`/api/v1/photos/${encodeURIComponent(id)}`);}
  folder(id: string): Promise<Folder> {return this.request<Folder>(`/api/v1/folders/${encodeURIComponent(id)}`);}
  liveStatus(ids: string[]): Promise<string[]> {
    if (!ids.length) {return Promise.resolve([]);}
    return this.request<{live_photo_ids: string[]}>(`/api/v1/live-photos/status?ids=${encodeURIComponent(ids.join(','))}`)
      .then(data => data.live_photo_ids);
  }
  async mediaSource(id: string, kind: 'thumbnail' | 'preview' | 'motion' | 'original') {
    const session = await this.validSession();
    const route = kind === 'motion' ? `/api/v1/live-photos/${encodeURIComponent(id)}` :
      `/api/v1/photos/${encodeURIComponent(id)}/${kind}${kind === 'thumbnail' ? '?size=256' : ''}`;
    return {uri: session.server + route, headers: {Authorization: `Bearer ${session.accessToken}`}};
  }
  async retryMedia() {
    const previous = this.session.server;
    await this.reconnect();
    if (previous === this.session.server) {await this.rotate();}
  }
}
