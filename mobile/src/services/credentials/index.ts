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

// Credential persistence should not block a successful server login.
// Some Android devices can fail Keystore initialization while the API
// authentication itself is already valid.
export const credentialsStore: CredentialsStore = {
  get: (...args) => nativeCredentials.get(...args),
  set: async (value) => {
    try {
      await nativeCredentials.set(value);
    } catch (error) {
      console.warn('Credential persistence unavailable', error);
    }
  },
  clear: (...args) => nativeCredentials.clear(...args),
  ...(nativeCredentials.refresh ? { refresh: (...args: Parameters<NonNullable<Spec['refresh']>>) => nativeCredentials.refresh!(...args) } : {}),
};

export function createCredentialsStore(nativeModule: CredentialsStore = credentialsStore): CredentialsStore {
  return nativeModule;
}
