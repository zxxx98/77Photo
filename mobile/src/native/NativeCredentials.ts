import type { TurboModule } from 'react-native';
import { NativeModules, TurboModuleRegistry } from 'react-native';

export type StoredCredentials = {
  serverId: string;
  deviceId: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
};

export interface Spec extends TurboModule {
  get(serverId: string): Promise<StoredCredentials | null>;
  set(value: StoredCredentials): Promise<void>;
  clear(serverId: string): Promise<void>;
  refresh(
    serverId: string,
    baseURL: string,
    attemptedAccessToken: string | null,
    lanCIDRs: readonly string[],
  ): Promise<StoredCredentials | null>;
}

const turboModule = TurboModuleRegistry.get<Spec>('NativeCredentials');
const legacyModule = NativeModules.NativeCredentials as Spec | undefined;

export default turboModule ?? legacyModule ?? null;
