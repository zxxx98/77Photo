import { describe, it, expect, vi } from 'vitest';
import { createApiClient } from './api';

describe('trash API', () => {
  it('uses independent authenticated routes and explicit permanent-delete confirmation', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ completed_ids: ['p1'], failed: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const api = createApiClient(fetcher as typeof fetch); api.setCsrfToken('csrf-trash');
    await api.restoreTrash(['p1'], { conflict: 'rename', folder_id: 'folder' });
    await api.purgeTrash(['p1']);
    await api.emptyTrash('mine', '2026-09-28T00:00:00Z');
    const calls = fetcher.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(call => call[0])).toEqual(['/api/v1/trash/photos/batch-restore', '/api/v1/trash/photos/batch-delete', '/api/v1/trash/photos/empty']);
    for (const [, init] of calls) {
      expect(init.method).toBe('POST'); expect(init.credentials).toBe('include');
      expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-trash');
    }
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ ids: ['p1'], conflict: 'rename', folder_id: 'folder' });
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ ids: ['p1'], confirm: true });
    expect(JSON.parse(String(calls[2][1].body))).toEqual({ scope: 'mine', before: '2026-09-28T00:00:00Z', confirm: true });
  });
});
