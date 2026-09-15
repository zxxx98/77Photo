import NativeUploadQueue, { type PickedMedia, type Spec, type UploadQueueSnapshot } from '../../native/NativeUploadQueue';

export type UploadQueueService = Pick<Spec, 'enqueue' | 'snapshot' | 'pause' | 'resume' | 'retryFailed' | 'cancel'>;

export function createUploadService(queue: UploadQueueService = NativeUploadQueue): UploadQueueService {
  return queue;
}

export const uploadQueue = createUploadService();

export type { PickedMedia, UploadQueueSnapshot };
