import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './api';

describe('bulk photo delete api', () => {
  it('sends one confirmed csrf-protected request for all selected photo ids', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ deleted_ids: ['a', 'b'], failed: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const api = createApiClient(fetcher as unknown as typeof fetch);
    api.setCsrfToken('csrf-token');

    if (!api.deletePhotos) throw new Error('deletePhotos is unavailable');
    const result = await api.deletePhotos(['a', 'b']);

    expect(result).toEqual({ deleted_ids: ['a', 'b'], failed: [] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/v1/photos/batch-delete');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-token');
    expect(JSON.parse(String(init.body))).toEqual({ ids: ['a', 'b'], confirm: true });
  });
});
