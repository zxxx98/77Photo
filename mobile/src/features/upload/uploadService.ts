import NativeUploadQueue, { type PickedMedia, type Spec, type UploadQueueSnapshot } from '../../native/NativeUploadQueue';

export type UploadQueueService = Pick<Spec, 'enqueue' | 'snapshot' | 'pause' | 'resume' | 'retryFailed' | 'cancel'> &
  Partial<Pick<Spec, 'start'>>;

const unavailableQueue: UploadQueueService = {
  enqueue: async () => { throw new Error('Android upload module is missing. Install the latest Android app build, then try again.'); },
  snapshot: async () => { throw new Error('Android upload module is missing. Install the latest Android app build, then try again.'); },
  pause: async () => { throw new Error('Android upload module is missing. Install the latest Android app build, then try again.'); },
  resume: async () => { throw new Error('Android upload module is missing. Install the latest Android app build, then try again.'); },
  retryFailed: async () => { throw new Error('Android upload module is missing. Install the latest Android app build, then try again.'); },
  cancel: async () => { throw new Error('Android upload module is missing. Install the latest Android app build, then try again.'); },
};

export function createUploadService(queue: UploadQueueService = NativeUploadQueue ?? unavailableQueue): UploadQueueService {
  return queue;
}

const STILL_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'heic', 'heif']);

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLocaleLowerCase('en-US');
}

function basename(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot < 0 ? name : name.slice(0, dot)).normalize('NFKC').toLocaleLowerCase('en-US');
}

/** Groups a selected still and same-basename MOV into one logical upload. */
export function pairPickedMedia(items: readonly PickedMedia[]): readonly PickedMedia[] {
  const motions = new Map<string, PickedMedia>();
  items.forEach((item) => {
    if (extension(item.displayName) === 'mov' && !motions.has(basename(item.displayName))) {
      motions.set(basename(item.displayName), item);
    }
  });

  return items.flatMap((item) => {
    const itemExtension = extension(item.displayName);
    if (itemExtension === 'mov') return [];
    if (!STILL_EXTENSIONS.has(itemExtension) || item.motion) return [item];
    const motion = motions.get(basename(item.displayName));
    if (!motion) return [item];
    motions.delete(basename(item.displayName));
    const { uri, displayName, mimeType, size } = motion;
    return [{ ...item, motion: { uri, displayName, mimeType, size } }];
  });
}

export function pickedMediaUris(items: readonly PickedMedia[]): readonly string[] {
  return Array.from(new Set(items.flatMap((item) => [item.uri, item.motion?.uri].filter((uri): uri is string => Boolean(uri)))));
}

export const uploadQueue = createUploadService();

export type { PickedMedia, UploadQueueSnapshot };
