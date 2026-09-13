import { translate, type Locale } from '../../app/i18n';
import type { ShareDuration, ShareResourceType } from '../../app/api';

export const shareDurations: ShareDuration[] = ['1_day', '7_days', 'forever'];

export function selectShareDuration(_current: ShareDuration, next: ShareDuration): ShareDuration {
  return next;
}

export function createCopyLinkHandler(copyLink: () => Promise<void>): () => void {
  return () => void copyLink();
}

export function durationLabel(duration: ShareDuration, locale: Locale = 'en'): string {
  const key = duration === '1_day' ? 'sharing.oneDay' : duration === '7_days' ? 'sharing.sevenDays' : 'sharing.forever';
  return translate(locale, key);
}

export function shareCopy(type: ShareResourceType, name: string, locale: Locale = 'en') {
  return {
    title: translate(locale, type === 'photo' ? 'sharing.sharePhotoTitle' : 'sharing.shareFolderTitle'),
    name,
    createLabel: translate(locale, type === 'photo' ? 'sharing.createPhotoLink' : 'sharing.createFolderLink'),
  };
}

export function shareButtonLabel(type: ShareResourceType, locale: Locale = 'en'): string {
  return translate(locale, type === 'photo' ? 'common.sharePhoto' : 'common.shareFolder');
}

export function successMessage(type: ShareResourceType, duration: ShareDuration, locale: Locale = 'en'): string {
  if (duration === 'forever') return translate(locale, type === 'photo' ? 'sharing.photoSharedForever' : 'sharing.folderSharedForever');
  return translate(locale, type === 'photo' ? 'sharing.photoSharedFor' : 'sharing.folderSharedFor', { duration: durationLabel(duration, locale) });
}
