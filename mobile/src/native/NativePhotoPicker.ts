import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

import type { PickedMedia } from './NativeUploadQueue';

export type { PickedMedia };

export interface Spec extends TurboModule {
  pick(): Promise<readonly PickedMedia[]>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativePhotoPicker');
