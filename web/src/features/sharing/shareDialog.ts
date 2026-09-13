import type { ShareDuration, ShareResourceType } from '../../app/api';

export const shareDurations: Array<{ value: ShareDuration; label: string; detail: string }> = [
  { value: '1_day', label: '1 day', detail: 'Short-term access' },
  { value: '7_days', label: '7 days', detail: 'Recommended' },
  { value: 'forever', label: 'Forever', detail: 'Does not expire' },
];

export function selectShareDuration(_current: ShareDuration, next: ShareDuration): ShareDuration {
  return next;
}

export function createCopyLinkHandler(copyLink: () => Promise<void>): () => void {
  return () => void copyLink();
}

export function shareCopy(type: ShareResourceType, name: string) {
  const resource = type === 'photo' ? 'photo' : 'folder';
  return {
    title: `Share ${resource}`,
    name,
    createLabel: `Create ${resource} link`,
    successPrefix: `${resource[0].toUpperCase()}${resource.slice(1)} shared`,
  };
}

export function shareButtonLabel(type: ShareResourceType): string {
  return `Share ${type}`;
}

export function successMessage(type: ShareResourceType, duration: ShareDuration): string {
  const copy = shareCopy(type, '');
  const label = duration === '1_day' ? '1 day' : duration === '7_days' ? '7 days' : 'forever';
  return duration === 'forever' ? `${copy.successPrefix} forever` : `${copy.successPrefix} for ${label}`;
}
