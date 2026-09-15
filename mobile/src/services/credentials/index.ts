import NativeCredentials, { type Spec, type StoredCredentials } from '../../native/NativeCredentials';

export type CredentialsStore = Pick<Spec, 'get' | 'set' | 'clear'>;

export type { StoredCredentials };

const unavailableCredentials: CredentialsStore = {
  get: async () => {
    throw new Error('NativeCredentials is unavailable');
  },
  set: async () => {
    throw new Error('NativeCredentials is unavailable');
  },
  clear: async () => {
    throw new Error('NativeCredentials is unavailable');
  },
};

export const credentialsStore: CredentialsStore = NativeCredentials ?? unavailableCredentials;

export function createCredentialsStore(nativeModule: CredentialsStore = credentialsStore): CredentialsStore {
  return nativeModule;
}
