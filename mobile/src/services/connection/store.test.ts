import type { ServerConfig } from './types';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
  },
}));

import { createConnectionStore } from './store';

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

describe('connection settings store', () => {
  it('persists server IDs and resets insecure confirmation when the URL changes', async () => {
    const storage = createMemoryStorage();
    const first = createConnectionStore({ storage, idFactory: () => 'server-1' });

    await first.getState().hydrate();
    const serverID = first.getState().addServer({
      baseURL: 'http://192.168.1.8:8080',
      displayName: 'Home',
      allowInsecureConfirmedAt: '2026-09-15T00:00:00.000Z',
    });
    await first.getState().flushPersistence();

    expect(serverID).toBe('server-1');
    expect(first.getState().selectedServerId).toBe('server-1');

    first.getState().updateServer('server-1', { baseURL: 'http://192.168.1.9:8080' });
    await first.getState().flushPersistence();

    const second = createConnectionStore({ storage, idFactory: () => 'server-2' });
    await second.getState().hydrate();

    expect(second.getState().servers).toEqual<ServerConfig[]>([
      {
        id: 'server-1',
        baseURL: 'http://192.168.1.9:8080',
        displayName: 'Home',
        allowInsecureConfirmedAt: null,
      },
    ]);
    expect(second.getState().selectedServerId).toBe('server-1');
  });

  it('accepts a reserved server ID so credentials and persisted server configuration stay aligned', async () => {
    const storage = createMemoryStorage();
    const store = createConnectionStore({ storage, idFactory: () => 'generated-server' });

    const id = store.getState().addServer({
      id: 'reserved-server',
      baseURL: 'https://photo.example',
      displayName: 'Home',
    });
    await store.getState().flushPersistence();

    expect(id).toBe('reserved-server');
    expect(store.getState().servers[0]?.id).toBe('reserved-server');
  });

  it('allows an existing insecure confirmation to be cleared explicitly', async () => {
    const storage = createMemoryStorage();
    const store = createConnectionStore({ storage, idFactory: () => 'server-1' });

    store.getState().addServer({
      baseURL: 'http://192.168.1.8:8080',
      displayName: 'Home',
      allowInsecureConfirmedAt: '2026-09-15T00:00:00.000Z',
    });
    store.getState().updateServer('server-1', { allowInsecureConfirmedAt: null });
    await store.getState().flushPersistence();

    expect(store.getState().servers[0]?.allowInsecureConfirmedAt).toBeNull();
  });

  it('persists the selected interface language and defaults invalid values to system', async () => {
    const storage = createMemoryStorage();
    const first = createConnectionStore({ storage });
    first.getState().setLanguage('en');
    await first.getState().flushPersistence();

    const second = createConnectionStore({ storage });
    await second.getState().hydrate();
    expect(second.getState().language).toBe('en');

    await storage.setItem('photo77.connection.settings.v1', JSON.stringify({ language: 'fr' }));
    const third = createConnectionStore({ storage });
    await third.getState().hydrate();
    expect(third.getState().language).toBe('system');
  });
});
