export type Locale = 'zh' | 'en';

export const DEFAULT_LOCALE: Locale = 'zh';
export const LOCALE_STORAGE_KEY = '77photo.locale';

export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type TranslationParams = Record<string, string | number>;

const english = {
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.retry': 'Retry',
  'common.save': 'Save',
  'common.delete': 'Delete',
  'common.confirmDelete': 'Confirm delete',
  'common.previousPhoto': 'Previous photo',
  'common.nextPhoto': 'Next photo',
  'common.downloadOriginal': 'Download original',
  'common.search': 'Search your library',
  'common.upload': 'Upload',
  'common.signOut': 'Sign out',
  'common.photos': '{count} photos',
  'common.folders': '{count} folders',
  'common.photo': 'photo',
  'common.folder': 'folder',
  'common.chooseFolder': 'Choose folder',
  'common.unknownFolder': 'Unknown folder',
  'common.sharePhoto': 'Share photo',
  'common.shareFolder': 'Share folder',
  'common.openNavigation': 'Open navigation',
  'common.closeNavigation': 'Close navigation',
  'common.primaryNavigation': 'Primary navigation',
  'common.mobileNavigation': 'Mobile navigation',
  'common.language': 'Language',

  'auth.familyLibrary': 'Your family library',
  'auth.keepMoments': 'Keep the moments close.',
  'auth.atmosphereDescription': 'A calm, private home for the photographs you want to remember.',
  'auth.storedOnOwnServer': 'Stored on your own server',
  'auth.welcomeBack': 'Welcome back',
  'auth.signInToLibrary': 'Sign in to your library',
  'auth.photosWaiting': 'Your photos are waiting, exactly where you left them.',
  'auth.username': 'Username',
  'auth.password': 'Password',
  'auth.tooManyAttempts': 'Too many attempts. Try again in a moment.',
  'auth.invalidCredentials': 'That username or password was not recognised.',
  'auth.signingIn': 'Signing in…',
  'auth.signIn': 'Sign in',
  'auth.invitedAccess': 'Only people you invite can access this library.',

  'shell.library': 'Library',
  'shell.gallery': 'Gallery',
  'shell.folders': 'Folders',
  'shell.settings': 'Settings',
  'shell.privateLibrary': 'Private library',
  'shell.storedOnServer': 'Stored on your server',
  'shell.administrator': 'Administrator',
  'shell.familyMember': 'Family member',
  'shell.privateMemories': 'private memories',
  'shell.openingLibrary': 'Opening your library…',

  'gallery.yourLibrary': 'Your library',
  'gallery.timeline': 'Timeline',
  'gallery.intro': 'A clear view of the moments you keep close.',
  'gallery.loaded': '{count} loaded',
  'gallery.noPhotosYet': 'No photos yet',
  'gallery.refresh': 'Refresh gallery',
  'gallery.filters': 'Gallery filters',
  'gallery.loading': 'Loading your library…',
  'gallery.allPhotos': 'All photos',
  'gallery.privateByDefault': 'Private by default',
  'gallery.yourPrivateLibrary': 'Your private library',
  'gallery.loadFailed': 'Unable to load your library. Try again.',
  'gallery.yourFirstRoll': 'Your first roll',
  'gallery.bringMemoryIntoView': 'Bring a memory into view.',
  'gallery.emptyDescription': 'Upload one photo and your library will start taking shape here, grouped by the day it was captured.',
  'gallery.uploadFirstPhoto': 'Upload first photo',
  'gallery.supportedStored': 'JPEG, PNG, MP4 or WebM · stored on your server',
  'gallery.previewPending': 'Preview pending',
  'gallery.firstMemory': 'First memory',
  'gallery.today': 'Today',
  'gallery.onePhoto': '{count} photo',
  'gallery.manyPhotos': '{count} photos',

  'folders.yourLibrary': 'Your library',
  'folders.title': 'Folders',
  'folders.newFolder': 'New folder',
  'folders.createFolder': 'Create folder',
  'folders.loading': 'Loading folders…',
  'folders.loadFailed': 'Unable to load folders.',
  'folders.createFailed': 'Folder could not be created.',
  'folders.emptyTitle': 'This folder is empty',
  'folders.emptyDescription': 'Create a folder to give your memories a calm home.',
  'folders.onePhoto': '{count} photo',
  'folders.manyPhotos': '{count} photos',
  'folders.oneFolder': '{count} folder',
  'folders.manyFolders': '{count} folders',

  'upload.addToLibrary': 'Add to your library',
  'upload.title': 'Upload',
  'upload.complete': '{completed}/{total} complete',
  'upload.destination': 'Destination',
  'upload.chooseFolder': 'Choose a folder',
  'upload.choosePhotos': 'Choose photos or videos',
  'upload.oneRequest': 'JPEG, PNG, MP4 or WebM · one request per file',
  'upload.waiting': 'Waiting',
  'upload.uploaded': 'Uploaded',
  'upload.cancelled': 'Cancelled',
  'upload.failed': 'Upload failed',
  'upload.progress': '{progress}%',
  'upload.cancelFile': 'Cancel {name}',
  'upload.uploadError': 'This file could not be uploaded.',

  'viewer.detailsFor': 'Details for {name}',
  'viewer.photoDetails': 'Photo details',
  'viewer.filename': 'Filename',
  'viewer.saveName': 'Save name',
  'viewer.moveTo': 'Move to',
  'viewer.move': 'Move',
  'viewer.captured': 'Captured',
  'viewer.size': 'Size',
  'viewer.folder': 'Folder',
  'viewer.nameUpdated': 'Name updated',
  'viewer.moved': 'Moved',
  'viewer.deleteFailed': 'Delete failed.',
  'viewer.renameFailed': 'Rename failed.',
  'viewer.moveFailed': 'Move failed.',
  'viewer.deletePhoto': 'Delete photo',
  'viewer.sharePhoto': 'Share photo',

  'sharing.publicLink': 'Public link',
  'sharing.sharePhotoTitle': 'Share photo',
  'sharing.shareFolderTitle': 'Share folder',
  'sharing.createPhotoLink': 'Create photo link',
  'sharing.createFolderLink': 'Create folder link',
  'sharing.photoSharedFor': 'Photo shared for {duration}',
  'sharing.folderSharedFor': 'Folder shared for {duration}',
  'sharing.folderSharedForever': 'Folder shared forever',
  'sharing.photoSharedForever': 'Photo shared forever',
  'sharing.anyoneCanView': 'Anyone with the link can view. No account or sign-in required.',
  'sharing.linkDuration': 'Link duration',
  'sharing.durationHelp': 'Choose when this link expires.',
  'sharing.oneDay': '1 day',
  'sharing.sevenDays': '7 days',
  'sharing.forever': 'Forever',
  'sharing.oneDayDetail': 'Short-term access',
  'sharing.sevenDaysDetail': 'Recommended',
  'sharing.foreverDetail': 'Does not expire',
  'sharing.optionalPassword': 'Optional password',
  'sharing.noPassword': 'Leave blank for no password',
  'sharing.creatingLink': 'Creating link…',
  'sharing.unableCreate': 'Unable to create the share link.',
  'sharing.shareLink': 'Share link',
  'sharing.copied': 'Copied',
  'sharing.copyLink': 'Copy link',
  'sharing.copyFailed': 'The link could not be copied.',
  'sharing.keepLinkPrivate': 'Keep this link private if it grants access to personal memories.',
  'sharing.closeDialog': 'Close share dialog',

  'public.openingMemories': 'Opening shared memories…',
  'public.unavailableTitle': 'This shared item is unavailable.',
  'public.unavailableDescription': 'The link may have expired or been removed.',
  'public.privateLink': 'Private link',
  'public.passwordRequired': 'Password required',
  'public.incorrectPassword': 'The password is incorrect.',
  'public.enterPassword': 'Enter the password to view this {resource}.',
  'public.checking': 'Checking…',
  'public.viewSharedMemories': 'View shared memories',
  'public.sharedResource': 'Shared {resource}',
  'public.viewOnly': 'View only',
  'public.loadingMemories': 'Loading memories…',
  'public.noPhotos': 'No photos in this shared item.',
  'public.footer': 'Shared from a private 77Photo library',

  'settings.yourAccount': 'Your account',
  'settings.title': 'Settings',
  'settings.familyAccounts': 'Family accounts',
  'settings.adminAccess': 'Admin access',
  'settings.onlyAdmins': 'Only administrators can view family accounts.',
  'settings.newUsername': 'Username',
  'settings.temporaryPassword': 'Temporary password',
  'settings.addMember': 'Add member',
  'settings.active': 'Active',
  'settings.disabled': 'Disabled',
  'settings.disable': 'Disable',
  'settings.enable': 'Enable',
  'settings.delete': 'Delete',
  'settings.confirmDelete': 'Delete {name}? Their photos will be retained.',
  'settings.accountUpdateFailed': 'Account could not be updated.',
  'settings.accountDeleteFailed': 'Account could not be deleted.',
  'settings.accountCreateFailed': 'Account could not be created.',
  'settings.libraryIndex': 'Library index',
  'settings.rescanFiles': 'Rescan files',
  'settings.scanQueued': 'Scan queued…',
  'settings.scanFailed': 'Scan could not be started.',
} as const;

export type TranslationKey = keyof typeof english;

const chinese: Record<TranslationKey, string> = {
  'common.close': '关闭',
  'common.cancel': '取消',
  'common.retry': '重试',
  'common.save': '保存',
  'common.delete': '删除',
  'common.confirmDelete': '确认删除',
  'common.previousPhoto': '上一张照片',
  'common.nextPhoto': '下一张照片',
  'common.downloadOriginal': '下载原图',
  'common.search': '搜索你的图库',
  'common.upload': '上传',
  'common.signOut': '退出登录',
  'common.photos': '{count} 张照片',
  'common.folders': '{count} 个文件夹',
  'common.photo': '照片',
  'common.folder': '文件夹',
  'common.chooseFolder': '选择文件夹',
  'common.unknownFolder': '未知文件夹',
  'common.sharePhoto': '分享照片',
  'common.shareFolder': '分享文件夹',
  'common.openNavigation': '打开导航',
  'common.closeNavigation': '关闭导航',
  'common.primaryNavigation': '主导航',
  'common.mobileNavigation': '移动端导航',
  'common.language': '语言',

  'auth.familyLibrary': '你的家庭图库',
  'auth.keepMoments': '把美好时刻留在身边。',
  'auth.atmosphereDescription': '一个安静、私密的空间，收藏那些值得记住的照片。',
  'auth.storedOnOwnServer': '存储在你自己的服务器上',
  'auth.welcomeBack': '欢迎回来',
  'auth.signInToLibrary': '登录你的图库',
  'auth.photosWaiting': '你的照片正在原处等你。',
  'auth.username': '用户名',
  'auth.password': '密码',
  'auth.tooManyAttempts': '尝试次数过多，请稍后再试。',
  'auth.invalidCredentials': '用户名或密码不正确。',
  'auth.signingIn': '正在登录…',
  'auth.signIn': '登录',
  'auth.invitedAccess': '只有受邀的人才能访问这个图库。',

  'shell.library': '图库',
  'shell.gallery': '照片',
  'shell.folders': '文件夹',
  'shell.settings': '设置',
  'shell.privateLibrary': '私密图库',
  'shell.storedOnServer': '存储在你的服务器上',
  'shell.administrator': '管理员',
  'shell.familyMember': '家庭成员',
  'shell.privateMemories': '私密回忆',
  'shell.openingLibrary': '正在打开图库…',

  'gallery.yourLibrary': '你的图库',
  'gallery.timeline': '时间线',
  'gallery.intro': '清晰查看那些被你珍藏的时刻。',
  'gallery.loaded': '已加载 {count} 张',
  'gallery.noPhotosYet': '还没有照片',
  'gallery.refresh': '刷新照片库',
  'gallery.filters': '照片筛选',
  'gallery.loading': '正在加载你的图库…',
  'gallery.allPhotos': '全部照片',
  'gallery.privateByDefault': '默认私密',
  'gallery.yourPrivateLibrary': '你的私密图库',
  'gallery.loadFailed': '无法加载图库，请重试。',
  'gallery.yourFirstRoll': '你的第一卷照片',
  'gallery.bringMemoryIntoView': '让一段回忆出现在眼前。',
  'gallery.emptyDescription': '上传一张照片，图库就会从这里开始，按拍摄日期整理你的回忆。',
  'gallery.uploadFirstPhoto': '上传第一张照片',
  'gallery.supportedStored': 'JPEG、PNG、MP4 或 WebM · 存储在你的服务器上',
  'gallery.previewPending': '预览暂不可用',
  'gallery.firstMemory': '第一段回忆',
  'gallery.today': '今天',
  'gallery.onePhoto': '{count} 张照片',
  'gallery.manyPhotos': '{count} 张照片',

  'folders.yourLibrary': '你的图库',
  'folders.title': '文件夹',
  'folders.newFolder': '新建文件夹',
  'folders.createFolder': '创建文件夹',
  'folders.loading': '正在加载文件夹…',
  'folders.loadFailed': '无法加载文件夹。',
  'folders.createFailed': '无法创建文件夹。',
  'folders.emptyTitle': '此文件夹为空',
  'folders.emptyDescription': '创建一个文件夹，为你的回忆安置一个安静的空间。',
  'folders.onePhoto': '{count} 张照片',
  'folders.manyPhotos': '{count} 张照片',
  'folders.oneFolder': '{count} 个文件夹',
  'folders.manyFolders': '{count} 个文件夹',

  'upload.addToLibrary': '添加到你的图库',
  'upload.title': '上传',
  'upload.complete': '{completed}/{total} 已完成',
  'upload.destination': '目标位置',
  'upload.chooseFolder': '选择文件夹',
  'upload.choosePhotos': '选择照片或视频',
  'upload.oneRequest': 'JPEG、PNG、MP4 或 WebM · 每个文件单独上传',
  'upload.waiting': '等待中',
  'upload.uploaded': '已上传',
  'upload.cancelled': '已取消',
  'upload.failed': '上传失败',
  'upload.progress': '{progress}%',
  'upload.cancelFile': '取消 {name}',
  'upload.uploadError': '此文件无法上传。',

  'viewer.detailsFor': '{name}的详细信息',
  'viewer.photoDetails': '照片详情',
  'viewer.filename': '文件名',
  'viewer.saveName': '保存名称',
  'viewer.moveTo': '移动到',
  'viewer.move': '移动',
  'viewer.captured': '拍摄时间',
  'viewer.size': '大小',
  'viewer.folder': '文件夹',
  'viewer.nameUpdated': '名称已更新',
  'viewer.moved': '已移动',
  'viewer.deleteFailed': '删除失败。',
  'viewer.renameFailed': '重命名失败。',
  'viewer.moveFailed': '移动失败。',
  'viewer.deletePhoto': '删除照片',
  'viewer.sharePhoto': '分享照片',

  'sharing.publicLink': '公开链接',
  'sharing.sharePhotoTitle': '分享照片',
  'sharing.shareFolderTitle': '分享文件夹',
  'sharing.createPhotoLink': '创建照片链接',
  'sharing.createFolderLink': '创建文件夹链接',
  'sharing.photoSharedFor': '照片分享期限：{duration}',
  'sharing.folderSharedFor': '文件夹分享期限：{duration}',
  'sharing.folderSharedForever': '文件夹已永久分享',
  'sharing.photoSharedForever': '照片已永久分享',
  'sharing.anyoneCanView': '任何拥有链接的人都可以查看，无需账号或登录。',
  'sharing.linkDuration': '链接期限',
  'sharing.durationHelp': '选择链接何时过期。',
  'sharing.oneDay': '1 天',
  'sharing.sevenDays': '7 天',
  'sharing.forever': '永久',
  'sharing.oneDayDetail': '适合短期访问',
  'sharing.sevenDaysDetail': '推荐',
  'sharing.foreverDetail': '永不过期',
  'sharing.optionalPassword': '可选密码',
  'sharing.noPassword': '留空表示不设置密码',
  'sharing.creatingLink': '正在创建链接…',
  'sharing.unableCreate': '无法创建分享链接。',
  'sharing.shareLink': '分享链接',
  'sharing.copied': '已复制',
  'sharing.copyLink': '复制链接',
  'sharing.copyFailed': '无法复制链接。',
  'sharing.keepLinkPrivate': '如果链接可以访问私人回忆，请妥善保管。',
  'sharing.closeDialog': '关闭分享对话框',

  'public.openingMemories': '正在打开分享的回忆…',
  'public.unavailableTitle': '此分享内容不可用。',
  'public.unavailableDescription': '链接可能已过期或被移除。',
  'public.privateLink': '私密链接',
  'public.passwordRequired': '需要密码',
  'public.incorrectPassword': '密码不正确。',
  'public.enterPassword': '输入密码以查看此{resource}。',
  'public.checking': '正在验证…',
  'public.viewSharedMemories': '查看分享的回忆',
  'public.sharedResource': '分享的{resource}',
  'public.viewOnly': '仅查看',
  'public.loadingMemories': '正在加载回忆…',
  'public.noPhotos': '此分享内容中没有照片。',
  'public.footer': '来自私密 77Photo 图库的分享',

  'settings.yourAccount': '你的账户',
  'settings.title': '设置',
  'settings.familyAccounts': '家庭账户',
  'settings.adminAccess': '管理员权限',
  'settings.onlyAdmins': '只有管理员可以查看家庭账户。',
  'settings.newUsername': '用户名',
  'settings.temporaryPassword': '临时密码',
  'settings.addMember': '添加成员',
  'settings.active': '启用',
  'settings.disabled': '已停用',
  'settings.disable': '停用',
  'settings.enable': '启用',
  'settings.delete': '删除',
  'settings.confirmDelete': '删除 {name}？其照片会保留。',
  'settings.accountUpdateFailed': '无法更新账户。',
  'settings.accountDeleteFailed': '无法删除账户。',
  'settings.accountCreateFailed': '无法创建账户。',
  'settings.libraryIndex': '图库索引',
  'settings.rescanFiles': '重新扫描文件',
  'settings.scanQueued': '扫描已排队…',
  'settings.scanFailed': '无法开始扫描。',
};

const translations: Record<Locale, Record<TranslationKey, string>> = { en: english, zh: chinese };

const unavailableStorage: LocaleStorage = {
  getItem: () => null,
  setItem: () => undefined,
};

export function browserStorage(): LocaleStorage {
  if (typeof window === 'undefined') return unavailableStorage;
  try {
    return window.localStorage;
  } catch {
    return unavailableStorage;
  }
}

export function readStoredLocale(storage: LocaleStorage): Locale {
  try {
    const value = storage.getItem(LOCALE_STORAGE_KEY);
    return value === 'en' || value === 'zh' ? value : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function setStoredLocale(storage: LocaleStorage, locale: Locale): Locale {
  try {
    storage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage can be unavailable in private browsing; memory state still works.
  }
  return locale;
}

export function translate(locale: Locale, key: TranslationKey, params: TranslationParams = {}): string {
  const template = translations[locale][key] ?? translations[DEFAULT_LOCALE][key] ?? key;
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params[name];
    return value === undefined ? placeholder : String(value);
  });
}

export function formatCount(locale: Locale, value: number): string {
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US').format(value);
}

export function formatDate(locale: Locale, value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatCalendarDate(locale: Locale, value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}
