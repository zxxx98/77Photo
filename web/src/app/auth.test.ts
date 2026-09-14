import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { SessionStore } from './auth';

describe('SessionStore', () => {
  it('restores a valid session on refresh', async () => {
    const api = {
      me: vi.fn().mockResolvedValue({ id: 'u1', username: 'alice', role: 'user', is_active: true }),
      setupStatus: vi.fn(),
      setupAdmin: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
    };
    const store = new SessionStore(api);

    await store.restore();

    expect(store.snapshot).toMatchObject({ status: 'authenticated', user: { username: 'alice' } });
  });

  it('opens first-run setup when there is no session and no users', async () => {
    const api = {
      me: vi.fn().mockRejectedValue(new Error('unauthorized')),
      setupStatus: vi.fn().mockResolvedValue({ required: true }),
      setupAdmin: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
    };
    const store = new SessionStore(api);

    await store.restore();

    expect(store.snapshot.status).toBe('setup');
  });

  it('opens login when setup has already completed', async () => {
    const api = {
      me: vi.fn().mockRejectedValue(new Error('unauthorized')),
      setupStatus: vi.fn().mockResolvedValue({ required: false }),
      setupAdmin: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
    };
    const store = new SessionStore(api);

    await store.restore();

    expect(store.snapshot.status).toBe('unauthenticated');
  });

  it('authenticates the first administrator and keeps the CSRF token in memory', async () => {
    const setCsrfToken = vi.fn();
    const api = {
      me: vi.fn(),
      setupStatus: vi.fn(),
      setupAdmin: vi.fn().mockResolvedValue({ user: { id: 'u1', username: 'owner', role: 'admin', is_active: true }, csrf_token: 'csrf' }),
      login: vi.fn(),
      logout: vi.fn(),
      setCsrfToken,
    };
    const store = new SessionStore(api);

    await store.setupAdmin('owner', 'correct horse battery staple');

    expect(store.snapshot).toMatchObject({ status: 'authenticated', user: { username: 'owner' } });
    expect(store.csrfToken).toBe('csrf');
    expect(setCsrfToken).toHaveBeenCalledWith('csrf');
  });

  it('refreshes setup state after a competing initialization', async () => {
    const api = {
      me: vi.fn().mockRejectedValue(new Error('unauthorized')),
      setupStatus: vi.fn().mockResolvedValue({ required: false }),
      setupAdmin: vi.fn().mockRejectedValue(new ApiError(409, 'SETUP_COMPLETE', 'setup complete')),
      login: vi.fn(),
      logout: vi.fn(),
    };
    const store = new SessionStore(api);

    await expect(store.setupAdmin('owner', 'correct horse battery staple')).rejects.toThrow('setup complete');

    expect(store.snapshot.status).toBe('unauthenticated');
  });

  it('keeps setup mounted after an ordinary setup failure', async () => {
    const api = {
      me: vi.fn().mockRejectedValue(new Error('unauthorized')),
      setupStatus: vi.fn().mockResolvedValue({ required: true }),
      setupAdmin: vi.fn().mockRejectedValue(new Error('network unavailable')),
      login: vi.fn(),
      logout: vi.fn(),
    };
    const store = new SessionStore(api);
    await store.restore();

    await expect(store.setupAdmin('owner', 'correct horse battery staple')).rejects.toThrow('network unavailable');

    expect(store.snapshot.status).toBe('setup');
    expect(api.setupStatus).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed login actionable without persisting credentials', async () => {
    const api = {
      me: vi.fn(),
      setupStatus: vi.fn(),
      setupAdmin: vi.fn(),
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
      setupStatus: vi.fn(),
      setupAdmin: vi.fn(),
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
