import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './api';

describe('duplicate API', () => {
  it('keeps cleanup tied to the reviewed group and protects the write with CSRF', async () => {
    const fetcher = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify({ deleted_ids: ['b'], failed: [] }), { headers: { 'Content-Type': 'application/json' } }));
    const api = createApiClient(fetcher as typeof fetch); api.setCsrfToken('csrf');
    const input = { group_id: 'group', version: 'snapshot', kind: 'exact' as const, keep_id: 'a', remove_ids: ['b'], confirm: true };
    await api.duplicates!.cleanup(input);
    const [path, init] = fetcher.mock.calls[0]; expect(path).toBe('/api/v1/admin/duplicates/cleanup'); expect(init?.method).toBe('POST'); expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf'); expect(JSON.parse(String(init?.body))).toEqual(input);
  });
  it('encodes group cursors and forwards cancellation', async () => {
    const fetcher = vi.fn(async (_path: string, _init?: RequestInit) => new Response('{}'));
    const api = createApiClient(fetcher as typeof fetch); const controller = new AbortController(); await api.duplicates!.groups('ai', 'a+b/', controller.signal);
    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/admin/duplicates/groups?kind=ai&cursor=a%2Bb%2F'); expect(fetcher.mock.calls[0][1]?.signal).toBe(controller.signal);
  });
});
