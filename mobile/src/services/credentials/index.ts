import NativeCredentials, { type Spec, type StoredCredentials } from '../../native/NativeCredentials';

export type CredentialsStore = Pick<Spec, 'get' | 'set' | 'clear'>;

export type { StoredCredentials };

export const credentialsStore: CredentialsStore = NativeCredentials;

export function createCredentialsStore(nativeModule: CredentialsStore = NativeCredentials): CredentialsStore {
  return nativeModule;
}
