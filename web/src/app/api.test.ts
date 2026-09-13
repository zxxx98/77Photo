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

  it('serializes gallery filters and folder pagination', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200 }));
    const client = createApiClient(fetcher as typeof fetch);

    await client.listPhotos({ folderId: 'f_1', cursor: 'cursor-value', limit: 25 });

    expect(fetcher).toHaveBeenCalledWith('/api/v1/photos?folder_id=f_1&cursor=cursor-value&limit=25', expect.objectContaining({ credentials: 'include' }));
  });

  it('uses XMLHttpRequest for upload progress and preserves FormData content type', async () => {
    const open = vi.fn();
    const send = vi.fn(function (this: { status: number; responseText: string; onload?: (event: ProgressEvent) => void }) {
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
    const file = new File(['data'], 'photo.jpg', { type: 'image/jpeg' });

    await expect(client.uploadPhoto(file, 'f_1')).resolves.toMatchObject({ id: 'p_1' });
    expect(open).toHaveBeenCalledWith('POST', '/api/v1/photos/upload');
    expect(send).toHaveBeenCalledWith(expect.any(FormData));
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
