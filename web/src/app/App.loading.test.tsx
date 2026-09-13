// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoPage, User } from './api';
import App from './App';
import { I18nProvider } from './I18nProvider';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function jsonResponse(payload: unknown): Response {
  return { ok: true, status: 200, headers: new Headers(), json: async () => payload } as Response;
}

describe('application loading transitions', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    originalFetch = globalThis.fetch;
    window.location.hash = '#/gallery';
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  });

  it('moves from app restore skeleton to gallery skeleton and resolved content', async () => {
    const userRequest = deferred<Response>();
    const photosRequest = deferred<Response>();
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/v1/auth/me') return userRequest.promise;
      if (path.startsWith('/api/v1/photos')) return photosRequest.promise;
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;

    await act(async () => { root.render(<I18nProvider><App /></I18nProvider>); });
    expect(container.querySelector('.app-shell-skeleton')).not.toBeNull();

    const user: User = { id: 'user-1', username: 'alice', role: 'admin', is_active: true };
    await act(async () => {
      userRequest.resolve(jsonResponse(user));
      await Promise.resolve();
    });
    expect(container.querySelector('.app-shell-skeleton')).toBeNull();
    expect(container.querySelector('.gallery-skeleton')).not.toBeNull();

    const page: PhotoPage = { items: [], next_cursor: null };
    await act(async () => {
      photosRequest.resolve(jsonResponse(page));
      await Promise.resolve();
    });
    expect(container.querySelector('.gallery-skeleton')).toBeNull();
    expect(container.querySelector('.empty-timeline')).not.toBeNull();
  });

  it('shows first-run setup when the installation has no users', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/v1/auth/me') return { ok: false, status: 401, headers: new Headers(), json: async () => ({ error: { code: 'AUTH_REQUIRED' } }) } as Response;
      if (path === '/api/v1/setup/status') return jsonResponse({ required: true });
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;

    await act(async () => {
      root.render(<I18nProvider><App /></I18nProvider>);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('.setup-page')).not.toBeNull();
    expect(container.querySelector('#setup-title')).not.toBeNull();
  });

  it('shows login when the installation is already initialized', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/v1/auth/me') return { ok: false, status: 401, headers: new Headers(), json: async () => ({ error: { code: 'AUTH_REQUIRED' } }) } as Response;
      if (path === '/api/v1/setup/status') return jsonResponse({ required: false });
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;

    await act(async () => {
      root.render(<I18nProvider><App /></I18nProvider>);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('.login-page')).not.toBeNull();
    expect(container.querySelector('.setup-page')).toBeNull();
  });
});
