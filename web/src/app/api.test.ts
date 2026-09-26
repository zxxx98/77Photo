import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './api';

describe('API client', () => {
  it('reads setup status and submits first administrator credentials', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ required: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: 'u1', username: 'owner', role: 'admin', is_active: true }, csrf_token: 'csrf' }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    const client = createApiClient(fetcher as typeof fetch);

    await expect(client.setupStatus()).resolves.toEqual({ required: true });
    await client.setupAdmin('owner', 'correct horse battery staple');

    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/setup/status');
    expect(fetcher.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'GET', credentials: 'include' }));
    expect(fetcher.mock.calls[1][0]).toBe('/api/v1/setup/admin');
    expect(JSON.parse((fetcher.mock.calls[1][1] as RequestInit).body as string)).toEqual({ username: 'owner', password: 'correct horse battery staple' });
  });

  it('sends same-origin credentials and decodes login response', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      user: { id: 'u1', username: 'admin', role: 'admin', is_active: true },
      csrf_token: 'csrf-value',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const client = createApiClient(fetcher as typeof fetch);

    const result = await client.login('admin', 'correct horse battery staple');

    expect(result.csrf_token).toBe('csrf-value');
    expect(fetcher).toHaveBeenCalledWith('/api/v1/auth/login', expect.objectContaining({ method: 'POST', credentials: 'include' }));
    const loginInit = fetcher.mock.calls[0][1] as RequestInit;
    expect(new Headers(loginInit.headers).get('Content-Type')).toBe('application/json');
  });

  it('turns structured API errors into ApiError without exposing response text', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'INVALID_CREDENTIALS', message: 'username or password is incorrect', request_id: 'req-1' },
    }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
    const client = createApiClient(fetcher as typeof fetch);

    await expect(client.login('admin', 'wrong password')).rejects.toEqual(
      new ApiError(401, 'INVALID_CREDENTIALS', 'username or password is incorrect', 'req-1'),
    );
  });

  it('adds the in-memory CSRF token to cookie-authenticated writes', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = createApiClient(fetcher as typeof fetch);
    client.setCsrfToken('csrf-value');

    await client.logout();

    const logoutInit = fetcher.mock.calls[0][1] as RequestInit;
    expect(new Headers(logoutInit.headers).get('X-CSRF-Token')).toBe('csrf-value');
  });

  it('captures a CSRF token returned while restoring a session', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'u1', username: 'admin', role: 'admin', is_active: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'restored-csrf' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createApiClient(fetcher as typeof fetch);

    await client.me();
    await client.logout();

    const logoutInit = fetcher.mock.calls[1][1] as RequestInit;
    expect(new Headers(logoutInit.headers).get('X-CSRF-Token')).toBe('restored-csrf');
  });

  it('starts a confirmed library reset and rescan', async () => {
    const job = {
      id: 'scan_reset',
      status: 'queued',
      started_at: '2026-09-19T12:00:00Z',
      counts: { scanned: 0, added: 0, updated: 0, missing: 0, failed: 0 },
    };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(job), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    }));
    const client = createApiClient(fetcher as typeof fetch);

    await expect(client.resetLibraryIndex()).resolves.toEqual(job);

    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/admin/rescan/reset',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ confirm: true }),
      }),
    );
  });

  it('loads a rescan job status by id', async () => {
    const job = {
      id: 'scan_1',
      status: 'running',
      started_at: '2026-09-15T01:00:00Z',
      counts: { scanned: 12, added: 3, updated: 8, missing: 1, failed: 0 },
    };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(job), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const client = createApiClient(fetcher as typeof fetch);

    await expect(client.getRescan('scan_1')).resolves.toEqual(job);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/admin/rescan/scan_1',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('serializes gallery filters and folder pagination', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200 }));
    const client = createApiClient(fetcher as typeof fetch);

    await client.listPhotos({ folderId: 'f_1', cursor: 'cursor-value', limit: 25 });

    expect(fetcher).toHaveBeenCalledWith('/api/v1/photos?folder_id=f_1&cursor=cursor-value&limit=25', expect.objectContaining({ credentials: 'include' }));
  });

  it('serializes map area filters and forwards the abort signal', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200 }));
    const client = createApiClient(fetcher as typeof fetch);
    const controller = new AbortController();

    await client.listPhotos({ bbox: [170, -20.5, -170, -10], from: '2025-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z', limit: 50, signal: controller.signal });

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    const query = new URL(path, 'https://77photo.test').searchParams;
    expect(query.get('bbox')).toBe('170,-20.5,-170,-10');
    expect(query.get('from')).toBe('2025-01-01T00:00:00Z');
    expect(query.get('to')).toBe('2026-01-01T00:00:00Z');
    expect(query.get('limit')).toBe('50');
    expect(init.signal).toBe(controller.signal);
  });

  it('loads one photo with its LIVE status', async () => {
    const photo = { id: 'p_1', owner_id: 'u_1', folder_id: 'f_1', filename: 'photo.heic', mime_type: 'image/heic', size: 1, captured_at: '2026-09-15T01:00:00Z', captured_at_source: 'exif', gps_latitude: 31.23, gps_longitude: 121.47 };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(photo), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ live_photo_ids: ['p_1'] }), { status: 200 }));
    const client = createApiClient(fetcher as typeof fetch);

    await expect(client.getPhoto('p_1')).resolves.toEqual({ ...photo, is_live_photo: true });
    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/photos/p_1');
  });

  it('loads map points and shares one map configuration request', async () => {
    const points = { items: [['p_1', 31.230416, 121.473701, '2026-09-01T08:30:00Z']], total_photos: 3 };
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(points), { status: 200 }));
    const client = createApiClient(fetcher as typeof fetch);

    await expect(client.getMapConfig()).rejects.toThrow('offline');
    await expect(client.getMapConfig()).resolves.toEqual({ enabled: false });
    await expect(client.getMapConfig()).resolves.toEqual({ enabled: false });
    await expect(client.getMapPoints()).resolves.toEqual(points);
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/v1/map/config', '/api/v1/map/config', '/api/v1/map/points']);
  });

  it('checks LIVE status in batches of at most 100 photo ids', async () => {
    const items = Array.from({ length: 205 }, (_, index) => ({
      id: `p_${index}`,
      owner_id: 'u_1',
      folder_id: 'f_1',
      filename: `photo-${index}.jpg`,
      mime_type: 'image/jpeg',
      size: 100,
      captured_at: '2026-09-15T01:00:00Z',
      captured_at_source: 'file_mod_time',
    }));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items, next_cursor: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ live_photo_ids: ['p_0'] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ live_photo_ids: ['p_100'] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ live_photo_ids: ['p_200'] }), { status: 200 }));
    const client = createApiClient(fetcher as typeof fetch);

    const page = await client.listPhotos({ limit: 205 });

    const statusCalls = fetcher.mock.calls.slice(1).map(([path]) => String(path));
    expect(statusCalls).toHaveLength(3);
    expect(statusCalls.map((path) => new URL(path, 'https://77photo.test').searchParams.get('ids')!.split(',').length)).toEqual([100, 100, 5]);
    expect(page.items.filter((photo) => photo.is_live_photo).map((photo) => photo.id)).toEqual(['p_0', 'p_100', 'p_200']);
  });

  it('uses XMLHttpRequest for upload progress and preserves original file modification time', async () => {
    const open = vi.fn();
    let submitted: FormData | undefined;
    const send = vi.fn(function (this: { status: number; responseText: string; onload?: (event: ProgressEvent) => void }, body: FormData) {
      submitted = body;
      this.status = 201;
      this.responseText = JSON.stringify({ id: 'p_1', filename: 'photo.jpg' });
      this.onload?.(undefined as unknown as ProgressEvent);
    });
    class FakeXHR {
      status = 0;
      responseText = '';
      upload = { onprogress: (_event: ProgressEvent) => undefined };
      onload?: (event: ProgressEvent) => void;
      onerror?: (event: ProgressEvent) => void;
      onabort?: (event: ProgressEvent) => void;
      open = open;
      setRequestHeader = vi.fn();
      send = send;
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    const client = createApiClient();
    const lastModified = Date.parse('2022-07-08T09:10:11.000Z');
    const file = new File(['data'], 'photo.jpg', { type: 'image/jpeg', lastModified });

    await expect(client.uploadPhoto(file, 'f_1')).resolves.toMatchObject({ id: 'p_1' });
    expect(open).toHaveBeenCalledWith('POST', '/api/v1/photos/upload');
    expect(send).toHaveBeenCalledWith(expect.any(FormData));
    expect(submitted!.get('file_modified_at')).toBe('2022-07-08T09:10:11.000Z');
  });

  it('uploads a still and motion companion in one ordered multipart request', async () => {
    const open = vi.fn();
    let submitted: FormData | undefined;
    const send = vi.fn(function (this: { status: number; responseText: string; onload?: (event: ProgressEvent) => void; upload: { onprogress: (event: ProgressEvent) => void } }, body: FormData) {
      submitted = body;
      this.upload.onprogress({ loaded: 10, total: 10 } as ProgressEvent);
      this.status = 201;
      this.responseText = JSON.stringify({ id: 'p_live', filename: 'photo.heic' });
      this.onload?.(undefined as unknown as ProgressEvent);
    });
    class FakeXHR {
      status = 0;
      responseText = '';
      upload = { onprogress: (_event: ProgressEvent) => undefined };
      onload?: (event: ProgressEvent) => void;
      onerror?: (event: ProgressEvent) => void;
      onabort?: (event: ProgressEvent) => void;
      open = open;
      setRequestHeader = vi.fn();
      send = send;
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    const client = createApiClient();
    const still = new File(['still'], 'photo.heic', { type: 'image/heic', lastModified: Date.parse('2024-05-20T17:30:00.000Z') });
    const motion = new File(['motion'], 'photo.mov', { type: 'video/quicktime' });
    const progress: Array<{ loaded: number; total: number }> = [];

    await expect(client.uploadLivePhoto(still, motion, 'f_1', (value) => progress.push(value))).resolves.toMatchObject({ id: 'p_live' });

    expect(open).toHaveBeenCalledWith('POST', '/api/v1/photos/live-upload');
    expect([...submitted!.keys()]).toEqual(['folder_id', 'conflict', 'file_modified_at', 'file', 'motion']);
    expect(submitted!.get('folder_id')).toBe('f_1');
    expect(submitted!.get('conflict')).toBe('reject');
    expect(submitted!.get('file_modified_at')).toBe('2024-05-20T17:30:00.000Z');
    expect((submitted!.get('file') as File).name).toBe('photo.heic');
    expect((submitted!.get('motion') as File).name).toBe('photo.mov');
    expect(progress).toEqual([{ loaded: 10, total: 10 }]);
  });

  it('serializes contextual share link requests and public share reads', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sl_1', resource_type: 'photo', resource_id: 'p_1', url: '/#/share/token', password_protected: true }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'f_1', name: 'Summer trip' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ resource_type: 'photo', name: 'photo.jpg', password_required: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ resource_type: 'photo', name: 'photo.jpg', password_required: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const client = createApiClient(fetcher as typeof fetch);

    await client.createShareLink({ resource_type: 'photo', resource_id: 'p_1', duration: '7_days', password: 'correct horse battery staple' });
    await client.getFolder('f_1');
    await client.getPublicShare('token');
    await client.unlockPublicShare('token', 'correct horse battery staple');
    await client.listPublicSharePhotos('token');

    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/share-links');
    expect(JSON.parse((fetcher.mock.calls[0][1] as RequestInit).body as string)).toEqual({ resource_type: 'photo', resource_id: 'p_1', duration: '7_days', password: 'correct horse battery staple' });
    expect(fetcher.mock.calls[1][0]).toBe('/api/v1/folders/f_1');
    expect(fetcher.mock.calls[2][0]).toBe('/api/v1/share-links/token');
    expect(fetcher.mock.calls[3][0]).toBe('/api/v1/share-links/token/unlock');
    expect(fetcher.mock.calls[4][0]).toBe('/api/v1/share-links/token/photos');
    expect(client.publicSharePreviewURL('token/value', 'p/1')).toBe('/api/v1/share-links/token%2Fvalue/photos/p%2F1/preview');
  });
});
