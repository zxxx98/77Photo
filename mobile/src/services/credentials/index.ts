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

export const credentialsStore: CredentialsStore = NativeCredentials ?? unavailableCredentials;

export function createCredentialsStore(nativeModule: CredentialsStore = credentialsStore): CredentialsStore {
  return nativeModule;
}
