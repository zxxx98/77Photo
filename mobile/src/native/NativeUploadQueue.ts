import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type UploadState = 'queued' | 'uploading' | 'paused' | 'succeeded' | 'failed' | 'canceled';

export type PickedMedia = {
  uri: string;
  displayName: string;
  mimeType: string;
  size: number | null;
};

export type UploadTask = {
  id: string;
  batchId: string;
  contentUri: string;
  displayName: string;
  mimeType: string;
  size: number | null;
  serverId: string;
  userId: string | null;
  deviceId: string;
  sessionId: string | null;
  folderId: string;
  state: UploadState;
  sentBytes: number;
  attempts: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAtEpochMs: number;
  startedAtEpochMs: number | null;
  completedAtEpochMs: number | null;
  nextRetryAtEpochMs: number | null;
  leaseOwner: string | null;
  leaseUntilEpochMs: number | null;
};

export type UploadQueueSnapshot = {
  tasks: readonly UploadTask[];
  queued: number;
  uploading: number;
  succeeded: number;
  failed: number;
  sentBytes: number;
  totalBytes: number;
};

export interface Spec extends TurboModule {
  start(
    serverId: string,
    baseURL: string,
    deviceId: string,
    concurrency: number,
    allowMobile: boolean,
    lanCIDRs: readonly string[],
  ): Promise<void>;
  enqueue(
    serverId: string,
    deviceId: string,
    folderId: string,
    items: readonly PickedMedia[],
  ): Promise<readonly string[]>;
  snapshot(serverId: string): Promise<UploadQueueSnapshot>;
  pause(serverId: string): Promise<void>;
  resume(serverId: string): Promise<void>;
  retryFailed(serverId: string): Promise<void>;
  cancel(taskIds: readonly string[]): Promise<void>;
}

export default TurboModuleRegistry.get<Spec>('NativeUploadQueue');
