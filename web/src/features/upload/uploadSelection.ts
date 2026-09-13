export interface UploadSelection {
  id: number;
  files: File[];
}

export interface QueuedUploadItem {
  file: File;
  status: 'queued';
  progress: number;
}

export function queuedItemsFromFiles(files: File[]): QueuedUploadItem[] {
  return files.map((file) => ({ file, status: 'queued', progress: 0 }));
}
