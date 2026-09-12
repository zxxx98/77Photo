import { describe, expect, it, vi } from 'vitest';
import { SessionStore } from './auth';

describe('SessionStore', () => {
  it('restores a valid session on refresh', async () => {
    const api = {
      me: vi.fn().mockResolvedValue({ id: 'u1', username: 'alice', role: 'user', is_active: true }),
      login: vi.fn(),
      logout: vi.fn(),
    };
    const store = new SessionStore(api);

    await store.restore();

    expect(store.snapshot).toMatchObject({ status: 'authenticated', user: { username: 'alice' } });
  });

  it('keeps a failed login actionable without persisting credentials', async () => {
    const api = {
      me: vi.fn(),
      login: vi.fn().mockRejectedValue(new Error('invalid')),
      logout: vi.fn(),
    };
    const store = new SessionStore(api);

    await expect(store.login('alice', 'secret password')).rejects.toThrow('invalid');

    expect(store.snapshot.status).toBe('unauthenticated');
    expect(store.snapshot.error).toBe('invalid');
    expect(JSON.stringify(store.snapshot)).not.toContain('secret password');
  });

  it('clears the user and CSRF token after logout', async () => {
    const api = {
      me: vi.fn().mockResolvedValue({ id: 'u1', username: 'alice', role: 'user', is_active: true }),
      login: vi.fn().mockResolvedValue({ user: { id: 'u1', username: 'alice', role: 'user', is_active: true }, csrf_token: 'csrf' }),
      logout: vi.fn().mockResolvedValue(undefined),
    };
    const store = new SessionStore(api);
    await store.login('alice', 'secret password');
    await store.logout();

    expect(store.snapshot).toEqual({ status: 'unauthenticated', user: null, error: null });
    expect(store.csrfToken).toBeNull();
  });
});
