import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

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
}

export default TurboModuleRegistry.get<Spec>('NativeCredentials');
