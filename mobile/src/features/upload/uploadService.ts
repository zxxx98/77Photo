import NativeUploadQueue, { type PickedMedia, type Spec, type UploadQueueSnapshot } from '../../native/NativeUploadQueue';

export type UploadQueueService = Pick<Spec, 'enqueue' | 'snapshot' | 'pause' | 'resume' | 'retryFailed' | 'cancel'> &
  Partial<Pick<Spec, 'start'>>;

const unavailableQueue: UploadQueueService = {
  enqueue: async () => { throw new Error('NativeUploadQueue is unavailable'); },
  snapshot: async () => { throw new Error('NativeUploadQueue is unavailable'); },
  pause: async () => { throw new Error('NativeUploadQueue is unavailable'); },
  resume: async () => { throw new Error('NativeUploadQueue is unavailable'); },
  retryFailed: async () => { throw new Error('NativeUploadQueue is unavailable'); },
  cancel: async () => { throw new Error('NativeUploadQueue is unavailable'); },
};

export function createUploadService(queue: UploadQueueService = NativeUploadQueue ?? unavailableQueue): UploadQueueService {
  return queue;
}

export const uploadQueue = createUploadService();

export type { PickedMedia, UploadQueueSnapshot };
