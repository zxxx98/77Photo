export interface UploadDestination {
  id: string;
  name: string;
}

export interface UploadSelection {
  id: number;
  files: File[];
  destination?: UploadDestination;
  returnToFolder?: boolean;
}

export interface QueuedUploadItem {
  file: File;
  liveVideo?: File;
  status: 'queued';
  progress: number;
}

function extension(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
}

function basename(name: string): string {
  const index = name.lastIndexOf('.');
  return (index >= 0 ? name.slice(0, index) : name).toLowerCase();
}

function isSupportedStill(file: File): boolean {
  return ['.jpg', '.jpeg', '.png', '.heic', '.heif'].includes(extension(file.name));
}

function isLiveMotion(file: File): boolean {
  return extension(file.name) === '.mov';
}

export function queuedItemsFromFiles(files: File[]): QueuedUploadItem[] {
  const motions = new Map<string, File[]>();
  for (const file of files) {
    if (!isLiveMotion(file)) continue;
    const key = basename(file.name);
    const entries = motions.get(key) ?? [];
    entries.push(file);
    motions.set(key, entries);
  }

  const pairedMotions = new Set<File>();
  const result: QueuedUploadItem[] = [];
  for (const file of files) {
    if (isLiveMotion(file) && pairedMotions.has(file)) continue;
    if (isSupportedStill(file)) {
      const candidates = motions.get(basename(file.name)) ?? [];
      const liveVideo = candidates.find((candidate) => !pairedMotions.has(candidate));
      if (liveVideo) {
        pairedMotions.add(liveVideo);
        result.push({ file, liveVideo, status: 'queued', progress: 0 });
        continue;
      }
    }
    if (isLiveMotion(file)) continue;
    if (!pairedMotions.has(file)) result.push({ file, status: 'queued', progress: 0 });
  }
  return result;
}

export function selectionFileIsQueued(file: File, items: Array<Pick<QueuedUploadItem, 'file' | 'liveVideo'>>): boolean {
  return items.some((item) => item.file === file || item.liveVideo === file);
}

export function shouldAutoStartAfterSelection(files: File[]): boolean {
  return queuedItemsFromFiles(files).length > 0;
}
