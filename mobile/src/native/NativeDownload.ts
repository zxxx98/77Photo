import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  download(
    url: string,
    fileName: string,
    authorization: string,
    lanCIDRs: readonly string[],
  ): Promise<number>;
}

export default TurboModuleRegistry.get<Spec>('NativeDownload');
