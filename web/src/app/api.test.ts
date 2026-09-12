import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './api';

describe('API client', () => {
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
});
