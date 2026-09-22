import NativeCredentials, { type Spec, type StoredCredentials } from '../../native/NativeCredentials';

export type CredentialsStore = Pick<Spec, 'get' | 'set' | 'clear'> & Partial<Pick<Spec, 'refresh'>>;

export type { StoredCredentials };

function unavailableCredentialsError(): Error & { code: string } {
  return Object.assign(new Error('NativeCredentials is unavailable'), { code: 'CREDENTIALS_ERROR' });
}

const unavailableCredentials: CredentialsStore = {
  get: async () => {
    throw unavailableCredentialsError();
  },
  set: async () => {
    throw unavailableCredentialsError();
  },
  clear: async () => {
    throw unavailableCredentialsError();
  },
};

const nativeCredentials = NativeCredentials ?? unavailableCredentials;

// Keep the most recent authenticated session in memory as a fallback. This is
// intentionally process-local: when Android Keystore is unavailable the user
// can still use the app after a successful login, but will need to sign in
// again after the app process is restarted.
const memoryCredentials = new Map<string, StoredCredentials>();

export const credentialsStore: CredentialsStore = {
  get: async (serverId) => {
    try {
      const stored = await nativeCredentials.get(serverId);
      if (stored) {
        memoryCredentials.set(serverId, stored);
        return stored;
      }
    } catch (error) {
      console.warn('Credential read unavailable; using in-memory session', error);
    }
    return memoryCredentials.get(serverId) ?? null;
  },
  set: async (value) => {
    // Populate memory first so the session remains immediately usable even if
    // the device cannot create/use an Android Keystore key.
    memoryCredentials.set(value.serverId, value);
    try {
      await nativeCredentials.set(value);
    } catch (error) {
      console.warn('Credential persistence unavailable; session is memory-only', error);
    }
  },
  clear: async (serverId) => {
    memoryCredentials.delete(serverId);
    try {
      await nativeCredentials.clear(serverId);
    } catch (error) {
      console.warn('Credential clear unavailable', error);
    }
  },
  ...(nativeCredentials.refresh
    ? {
        refresh: async (...args: Parameters<NonNullable<Spec['refresh']>>) => {
          try {
            const refreshed = await nativeCredentials.refresh!(...args);
            if (refreshed) memoryCredentials.set(refreshed.serverId, refreshed);
            return refreshed;
          } catch (error) {
            console.warn('Native credential refresh unavailable', error);
            return null;
          }
        },
      }
    : {}),
};

export function createCredentialsStore(nativeModule: CredentialsStore = credentialsStore): CredentialsStore {
  return nativeModule;
}
