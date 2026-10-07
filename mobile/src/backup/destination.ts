import {ApiError} from '../auth/api';
import type {BrowseApi, Folder} from '../browse/api';

export type MediaDates = {capturedAt?: number; addedAt?: number; modifiedAt?: number};

// MediaStore capture times are milliseconds; the native bridge also converts
// added/modified times to milliseconds. Use the device's local calendar date.
export function backupDateParts(media: MediaDates): string[] {
  for (const timestamp of [media.capturedAt, media.addedAt, media.modifiedAt]) {
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {continue;}
    const date = new Date(timestamp);
    const year = date.getFullYear();
    if (!Number.isFinite(year) || year < 1 || year > 9999) {continue;}
    return [String(year).padStart(4, '0'), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')];
  }
  return ['日期未知'];
}

// Cache only within one scan so a later run sees deleted folders and changed
// permissions. Creation responses lost in transit are reconciled by listing
// on the next scan, rather than replaying the POST.
export function dateDestination(api: BrowseApi, root: Folder, signal: AbortSignal) {
  const children = new Map<string, Folder[]>();
  const checkStopped = () => {if (signal.aborted) {throw new Error('备份已暂停');}};
  const list = async (parent: Folder) => {
    checkStopped();
    const result = await api.request<{items: Folder[]}>(`/api/v1/folders?parent_id=${encodeURIComponent(parent.id)}`);
    checkStopped();
    const folders = result.items.filter(folder => folder.parent_id === parent.id && folder.owner_id === root.owner_id);
    children.set(parent.id, folders);
    return folders;
  };
  // Manual queues can pass a saved calendar path so a timezone change before
  // retry does not alter the destination selected when the task was enqueued.
  return async (media: MediaDates, parts: readonly string[] = backupDateParts(media)): Promise<Folder> => {
    let parent = root;
    for (const name of parts) {
      checkStopped();
      const folders = children.get(parent.id) ?? await list(parent);
      let child = folders.find(folder => folder.name === name);
      if (!child) {
        try {
          checkStopped();
          child = await api.createFolder(name, parent.id);
          checkStopped();
          folders.push(child);
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 409 && error.code === 'NAME_CONFLICT')) {throw error;}
          // Another device can create the same date directory concurrently.
          child = (await list(parent)).find(folder => folder.name === name);
          if (!child) {throw error;}
        }
      }
      if (child.effective_permission === 'read') {
        throw new ApiError(403, 'WRITE_FORBIDDEN', '日期文件夹已无写入权限');
      }
      parent = child;
    }
    return parent;
  };
}
