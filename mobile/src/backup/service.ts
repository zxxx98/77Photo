import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import {DeviceEventEmitter, NativeModules, PermissionsAndroid, Platform} from 'react-native';
import {loadSession, type MobileSession} from '../auth/session';
import {ApiError} from '../auth/api';
import {BrowseApi, type Folder} from '../browse/api';
import {uploadError, uploadOne, type UploadItem} from '../upload/queue';

export type BackupSettings = {enabled: boolean; videoEnabled?: boolean; wifiOnly: boolean; folder: Folder | null};
export type LibraryPhoto = {id: string; uri: string; fingerprint: string; legacyFingerprint?: string; name: string; mime: string; size: number};
type RetryState = {until: number; attempts: number};
type LegacyCompletion = {completed: Record<string, true>; cursor?: string; lastRun?: string};
type BackupRecord = {settings: BackupSettings; completed: Record<string, true>; blocked?: Record<string, string>; cursor?: string; videoCursor?: string;
  lastRun?: string; lastVideoRun?: string; message?: string; pendingForegroundVideo?: string; targetBlocked?: string;
  retry?: Partial<Record<'photo' | 'video', RetryState>>; unverifiedLegacy?: LegacyCompletion;
  migratedTo?: string;
  histories?: Record<string, {completed: Record<string, true>; blocked?: Record<string, string>; cursor?: string; videoCursor?: string;
    lastRun?: string; lastVideoRun?: string; retry?: Partial<Record<'photo' | 'video', RetryState>>}>};
const native = NativeModules.Photo77Backup as {
  schedule(enabled: boolean, wifiOnly: boolean): Promise<void>;
  scan(after: string, mediaType: 'photo' | 'video'): Promise<{items: LibraryPhoto[]; next: string}>;
  stage(uri: string, size: number): Promise<string>;
  startVisible(scope: string): Promise<void>;
  updateVisible(name: string, progress: number, fingerprint: string): Promise<void>;
  stopVisible(preservePending: boolean): Promise<void>;
  interruptedVisible?(scope: string): Promise<{fingerprint: string; action: 'pause' | 'cancel'} | null>;
  clearInterruptedVisible?(scope: string): Promise<void>;
};
const defaults = (): BackupRecord => ({settings: {enabled: false, videoEnabled: false, wifiOnly: true, folder: null}, completed: {}});
// Keep the app-side cap below Android 15's six-hour dataSync service window.
const visibleVideoTimeoutMs = 5 * 60 * 60 * 1000;
const backgroundVideoMaxBytes = 128 * 1024 * 1024;
const legacyBackupKey = (session: MobileSession) => `backup:v1:${encodeURIComponent(session.profile?.id ?? session.server)}:${encodeURIComponent(session.username)}`;
export const backupKey = (session: MobileSession) => session.userId
  ? `backup:v2:${encodeURIComponent(session.profile?.id ?? session.server)}:${encodeURIComponent(session.userId)}`
  : legacyBackupKey(session);
let running: Promise<void> | undefined;
let stopped = false;
let abort: AbortController | undefined;
let stopVersion = 0;
let configuring = false;
let uiMounted = false;
let foregroundApi: {api: BrowseApi; session: MobileSession} | undefined;
let liveProgress: {key: string; message: string} | undefined;
let visibleRunning = false;
let visibleStarting = false;
let visibleStopReason: 'pause' | 'cancel' | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
export const subscribeBackup = (listener: () => void) => {listeners.add(listener); return () => {listeners.delete(listener);};};
export const isVisibleBackupRunning = () => visibleRunning;
const visibleScope = (session: MobileSession, folderId: string) => `${backupKey(session)}:${encodeURIComponent(folderId)}`;
export async function readBackup(session: MobileSession): Promise<BackupRecord> {
  let raw = await AsyncStorage.getItem(backupKey(session));
  if (!raw && session.userId) {
    const legacyKey = legacyBackupKey(session);
    const old = await AsyncStorage.getItem(legacyKey);
    if (old) {
      const previous = JSON.parse(old) as BackupRecord;
      if (!previous.migratedTo || previous.migratedTo === session.userId) {
        if (!previous.unverifiedLegacy) {
          previous.unverifiedLegacy = {completed: previous.completed, cursor: previous.cursor, lastRun: previous.lastRun};
          previous.completed = {};
          previous.cursor = '0';
          previous.lastRun = undefined;
          // The older username scope cannot prove ownership of other folders.
          previous.histories = {};
        }
        raw = JSON.stringify(previous);
        // A reused username must not claim the old key before its original
        // folder owner has had a chance to migrate it.
        if (previous.settings.folder?.owner_id === session.userId) {
          previous.migratedTo = session.userId;
          raw = JSON.stringify(previous);
          await AsyncStorage.setItem(legacyKey, raw);
        }
        await AsyncStorage.setItem(backupKey(session), raw);
      }
    }
  }
  if (!raw) {return defaults();}
  const record = JSON.parse(raw) as BackupRecord;
  // Existing photo history stays valid when video backup is introduced.
  record.settings.videoEnabled ??= false;
  record.blocked ??= {};
  if (liveProgress?.key === backupKey(session)) {record.message = liveProgress.message;}
  return record;
}
async function writeBackup(session: MobileSession, record: BackupRecord) {
  await AsyncStorage.setItem(backupKey(session), JSON.stringify(record));
  notify();
}
export async function requestMediaAccess(mediaType: 'photo' | 'video') {
  if (Platform.OS !== 'android') {throw new Error('自动备份目前仅支持 Android');}
  const permission = Number(Platform.Version) >= 33 ? (mediaType === 'video' ? PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO : PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES) : PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE;
  if (await PermissionsAndroid.check(permission)) {return;}
  const result = Number(Platform.Version) >= 34 ? (await PermissionsAndroid.requestMultiple([
    permission, PermissionsAndroid.PERMISSIONS.READ_MEDIA_VISUAL_USER_SELECTED,
  ]))[permission] : await PermissionsAndroid.request(permission);
  if (result !== PermissionsAndroid.RESULTS.GRANTED || !await PermissionsAndroid.check(permission)) {
    if (Number(Platform.Version) >= 34 &&
        await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_MEDIA_VISUAL_USER_SELECTED)) {
      throw new Error(`目前只允许访问选定${mediaType === 'video' ? '视频' : '照片'}；请在系统设置中改为允许全部媒体`);
    }
    throw new Error(`请在系统设置中允许访问全部${mediaType === 'video' ? '视频' : '照片'}，再开启自动备份`);
  }
}
export const requestPhotoAccess = () => requestMediaAccess('photo');
export async function requestVisibleNotificationAccess() {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 33) {return;}
  const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
  if (await PermissionsAndroid.check(permission)) {return;}
  if (await PermissionsAndroid.request(permission) !== PermissionsAndroid.RESULTS.GRANTED) {
    throw new Error('请允许备份通知后启动可见视频传输');
  }
}
export async function stopBackup() {
  stopVersion++;
  stopped = true;
  abort?.abort();
  await running;
}
// Authentication changes wait for any headless upload/token refresh to finish.
export async function enterBackupUI() {uiMounted = true; await stopBackup();}
export function leaveBackupUI() {uiMounted = false; foregroundApi = undefined;}
export function bindBackup(api: BrowseApi, session: MobileSession) {
  foregroundApi = {api, session};
  return () => {if (foregroundApi?.api === api) {foregroundApi = undefined;}};
}
export async function restoreBackupSchedule(session: MobileSession) {
  const record = await readBackup(session);
  if (record.settings.enabled || record.settings.videoEnabled) {await native.schedule(true, record.settings.wifiOnly);}
}
export async function configureBackup(session: MobileSession, settings: BackupSettings) {
  configuring = true;
  try {
    await stopBackup();
    const record = await readBackup(session);
    // A different destination must get its own full scan.
    if (record.settings.folder?.id !== settings.folder?.id) {
      record.unverifiedLegacy = undefined;
      record.histories ??= {};
      const oldId = record.settings.folder?.id;
      if (oldId) {record.histories[oldId] = {completed: record.completed, cursor: record.cursor,
        blocked: record.blocked, videoCursor: record.videoCursor, lastRun: record.lastRun,
        lastVideoRun: record.lastVideoRun, retry: record.retry};}
      const saved = settings.folder?.id ? record.histories[settings.folder.id] : undefined;
      record.completed = saved?.completed ?? {};
      record.blocked = saved?.blocked ?? {};
      record.retry = saved?.retry ?? {};
      record.cursor = saved?.cursor ?? '0';
      record.videoCursor = saved?.videoCursor ?? '0';
      record.lastRun = saved?.lastRun;
      record.lastVideoRun = saved?.lastVideoRun;
      record.targetBlocked = undefined;
    }
    record.settings = {...settings, videoEnabled: settings.videoEnabled ?? false};
    if (!record.settings.videoEnabled) {record.pendingForegroundVideo = undefined;}
    record.message = settings.enabled || settings.videoEnabled ? '等待自动备份' : '自动备份已关闭';
    await writeBackup(session, record);
    try {await native.schedule(!!(settings.enabled || settings.videoEnabled), settings.wifiOnly);}
    catch (error) {
      record.settings.enabled = false;
      record.settings.videoEnabled = false;
      record.message = '无法安排后台备份，请重新开启';
      await writeBackup(session, record);
      throw error;
    }
  } finally {configuring = false;}
}
export async function disableBackup(session: MobileSession) {
  const record = await readBackup(session);
  await configureBackup(session, {...record.settings, enabled: false, videoEnabled: false});
}
export async function retryBlockedBackup(session: MobileSession) {
  await stopBackup();
  const record = await readBackup(session);
  record.blocked = {};
  record.retry = {};
  record.targetBlocked = undefined;
  record.cursor = '0';
  record.videoCursor = '0';
  record.message = '正在重新检查之前未完成的媒体';
  await writeBackup(session, record);
}
export function networkAllowsBackup(settings: BackupSettings, network: {isConnected: boolean | null; isInternetReachable: boolean | null; type: string}) {
  return network.isConnected === true && network.isInternetReachable !== false && (!settings.wifiOnly || network.type === 'wifi');
}

async function performBackup(session: MobileSession, api: BrowseApi, background = false, visible = false) {
  const record = await readBackup(session);
  if ((!record.settings.enabled && !record.settings.videoEnabled) || !record.settings.folder) {return;}
  if (record.targetBlocked) {record.message = record.targetBlocked; await writeBackup(session, record); return;}
  let markerToClear = false;
  const scope = visibleScope(session, record.settings.folder.id);
  if (background && native.interruptedVisible) {
    const marker = await native.interruptedVisible(scope).catch(() => null);
    if (marker) {
      markerToClear = true;
      if (!record.completed[marker.fingerprint]) {
        if (marker.action === 'cancel') {
          record.blocked ??= {};
          record.blocked[marker.fingerprint] = '已取消，点重新尝试后继续';
          record.pendingForegroundVideo = undefined;
        } else {record.pendingForegroundVideo = marker.fingerprint;}
      }
    }
  }
  const deadline = Date.now() + 90000;
  abort = new AbortController();
  let interruptedVideo: string | undefined;
  let networkInterrupted = false;
  let unsubscribeNetwork: (() => void) | undefined;
  const timer = background ? setTimeout(() => {
    stopped = true;
    abort?.abort();
  }, 180000) : undefined;
  const kinds = (['photo', 'video'] as const).filter(kind => kind === 'photo'
    ? record.settings.enabled && !visible : record.settings.videoEnabled);
  const pages: Partial<Record<'photo' | 'video', LibraryPhoto[]>> = {};
  const done = new Set<'photo' | 'video'>();
  const counts = {photo: 0, video: 0};
  let failures = 0;
  const failed = {photo: 0, video: 0};
  const markFailure = (kind: 'photo' | 'video') => {failures++; failed[kind]++;};
  let lastError = '';
  try {
    if (!networkAllowsBackup(record.settings, await NetInfo.fetch())) {
      record.message = record.settings.wifiOnly ? '等待 Wi-Fi 连接' : '等待网络连接';
      return;
    }
    const destination = await api.request<Folder>(`/api/v1/folders/${encodeURIComponent(record.settings.folder.id)}`);
    if (destination.effective_permission === 'read') {
      throw new ApiError(403, 'WRITE_FORBIDDEN', '目标文件夹已无写入权限');
    }
    if (record.unverifiedLegacy) {
      // The folder may have been transferred since the username-scoped record
      // was saved. Both its recorded owner and current owner must be this account.
      if (session.userId && record.settings.folder.owner_id === session.userId &&
          destination.owner_id === session.userId) {
        record.completed = record.unverifiedLegacy.completed;
        record.cursor = record.unverifiedLegacy.cursor ?? '0';
        record.lastRun = record.unverifiedLegacy.lastRun;
      }
      record.unverifiedLegacy = undefined;
      await writeBackup(session, record);
    }
    unsubscribeNetwork = NetInfo.addEventListener(state => {
      if (state.isConnected === false || state.isInternetReachable === false ||
          record.settings.wifiOnly && state.type !== 'wifi' && state.type !== 'unknown') {
        networkInterrupted = true;
        stopped = true;
        abort?.abort();
      }
    });
    record.message = '正在扫描媒体…';
    await writeBackup(session, record);
    while (!stopped && (!background || Date.now() < deadline) && done.size < kinds.length) {
      for (const kind of kinds) {
        if (done.has(kind)) {continue;}
        if (record.retry?.[kind] && record.retry[kind]!.until > Date.now()) {
          markFailure(kind);
          lastError = `${kind === 'video' ? '视频' : '照片'}等待网络或服务器恢复后重试`;
          done.add(kind);
          continue;
        }
        if (stopped || (background && Date.now() >= deadline)) {
          record.message = networkInterrupted ? '网络条件变化，等待连接恢复后继续' : '已暂停，将在下次检查时继续';
          return;
        }
        const cursor = kind === 'photo' ? record.cursor ?? '0' : record.videoCursor ?? '0';
        if (!pages[kind]?.length) {
          let page;
          try {page = await native.scan(cursor, kind);}
          catch (error) {
            if (kind === 'photo') {throw error;}
            markFailure(kind);
            lastError = `视频扫描：${error instanceof Error ? error.message : '请检查视频访问权限'}`;
            done.add(kind);
            continue;
          }
          if (!page.items.length) {
            if (record.retry) {delete record.retry[kind];}
            if (kind === 'photo') {record.cursor = '0'; if (!failed.photo) {record.lastRun = new Date().toISOString();}}
            else {
              record.videoCursor = '0';
              record.pendingForegroundVideo = undefined;
              if (!failed.video) {record.lastVideoRun = new Date().toISOString();}
            }
            done.add(kind);
            continue;
          }
          if (page.next === cursor) {throw new Error('相册扫描未能继续，请重新打开应用');}
          pages[kind] = page.items;
        }
        const media = pages[kind]!.shift()!;
        const advance = () => {if (kind === 'photo') {record.cursor = media.id;} else {record.videoCursor = media.id;}};
        if (background && kind === 'video' && record.pendingForegroundVideo === media.fingerprint) {
          done.add('video');
          continue;
        }
        if (record.completed[media.fingerprint] || (media.legacyFingerprint && record.completed[media.legacyFingerprint])) {
          if (media.legacyFingerprint) {record.completed[media.fingerprint] = true; delete record.completed[media.legacyFingerprint];}
          advance();
          continue;
        }
        if (record.blocked?.[media.fingerprint]) {
          markFailure(kind);
          lastError = `${media.name}：${record.blocked[media.fingerprint]}`;
          advance();
          continue;
        }
        if (kind === 'video' && !['video/mp4', 'video/webm'].includes(media.mime)) {
          markFailure(kind);
          lastError = `${media.name}：暂不支持 ${media.mime || '未知'} 格式`;
          advance();
          continue;
        }
        if (background && kind === 'video' && media.size > backgroundVideoMaxBytes) {
          record.pendingForegroundVideo = media.fingerprint;
          record.message = `${media.name} 较大，等待可见视频传输`;
          await writeBackup(session, record);
          done.add('video');
          continue;
        }
        if (background && kind === 'video' && Date.now() + 60000 > deadline) {
          markFailure(kind);
          lastError = `${media.name}：本轮时间不足，等待下次后台检查`;
          done.add('video');
          continue;
        }
        if (!networkAllowsBackup(record.settings, await NetInfo.fetch())) {record.message = '网络条件不满足，等待下次检查'; return;}
        let path: string | undefined;
        try {
          if (background && kind === 'video') {
            // Persist the in-flight file before staging: process death may not
            // run JS cleanup, and the next job must not repeat a large copy.
            record.pendingForegroundVideo = media.fingerprint;
            record.message = `正在暂存视频：${media.name}`;
            await writeBackup(session, record);
          }
          if (visible && kind === 'video') {await native.updateVisible(media.name, -1, media.fingerprint);}
          path = await native.stage(media.uri, media.size);
          if (stopped) {
            if (networkInterrupted) {
              if (kind === 'video') {record.pendingForegroundVideo = undefined;}
              record.message = '网络条件变化，等待连接恢复后继续';
            }
            else if ((background || visible) && kind === 'video') {
              if (visibleStopReason === 'cancel') {
                record.blocked ??= {};
                record.blocked[media.fingerprint] = '已取消，点重新尝试后继续';
                record.pendingForegroundVideo = undefined;
                record.message = '已取消当前视频传输';
              } else {
                record.pendingForegroundVideo = media.fingerprint;
                record.message = '视频等待打开应用继续传输';
              }
            }
            return;
          }
          const item: UploadItem = {...media, path, id: media.fingerprint, folderId: record.settings.folder.id,
            folderName: record.settings.folder.name, status: 'waiting', progress: 0};
          record.message = `正在备份${kind === 'video' ? '视频' : '照片'}：${media.name}`;
          await writeBackup(session, record);
          await uploadOne(api, item, value => {
            liveProgress = {key: backupKey(session), message: `正在备份：${media.name} ${value}%`};
            if (visible && kind === 'video') {native.updateVisible(media.name, value, media.fingerprint).catch(() => {});}
            notify();
          }, abort.signal, kind === 'video' ? visibleVideoTimeoutMs : undefined);
          liveProgress = undefined;
          record.completed[media.fingerprint] = true;
          delete record.blocked?.[media.fingerprint];
          if (record.retry) {delete record.retry[kind];}
          if (kind === 'video') {record.pendingForegroundVideo = undefined;}
          advance();
          counts[kind]++;
          await writeBackup(session, record);
        } catch (error) {
          if (!networkInterrupted && (background || visible) && stopped && kind === 'video') {interruptedVideo = media.fingerprint;}
          if ((!stopped || networkInterrupted) && kind === 'video') {record.pendingForegroundVideo = undefined;}
          if (stopped || (error instanceof ApiError && [401, 403, 404].includes(error.status))) {throw error;}
          if (error instanceof TypeError || error instanceof ApiError && (error.status === 429 || error.status >= 500)) {
            const attempts = (record.retry?.[kind]?.attempts ?? 0) + 1;
            record.retry ??= {};
            record.retry[kind] = {attempts, until: Date.now() + Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** Math.min(attempts - 1, 6))};
            markFailure(kind);
            lastError = `${media.name}：${uploadError(error)}，稍后重试`;
            done.add(kind);
            continue;
          }
          markFailure(kind);
          lastError = `${media.name}：${error instanceof Error && !(error instanceof ApiError) ? error.message : uploadError(error)}`;
          if (error instanceof ApiError && [413, 415, 422].includes(error.status) ||
              error instanceof Error && error.message.includes('暂存空间不足')) {
            record.blocked ??= {};
            record.blocked[media.fingerprint] = lastError.slice(media.name.length + 1);
          }
          advance();
        } finally {
          if (path) {await NativeModules.Photo77Picker.deleteFile(path).catch(() => {});}
        }
      }
    }
    record.message = networkInterrupted ? '网络条件变化，等待连接恢复后继续' : done.size === kinds.length
      ? record.pendingForegroundVideo ? '视频等待打开应用继续传输' : failures ? `${failures} 项未完成，稍后重试：${lastError}` : `备份检查完成，本次确认 ${counts.photo} 张照片、${counts.video} 个视频`
      : '已暂停，将在下次检查时继续';
  } catch (error) {
    if ((background || visible) && interruptedVideo) {record.pendingForegroundVideo = interruptedVideo;}
    if (error instanceof ApiError && [403, 404].includes(error.status)) {
      record.targetBlocked = error.status === 404 ? '目标文件夹已删除，请重新选择备份目录' : '目标文件夹已无写入权限，请检查共享设置';
    }
    if (visibleStopReason === 'cancel' && interruptedVideo) {
      record.blocked ??= {};
      record.blocked[interruptedVideo] = '已取消，点重新尝试后继续';
      record.pendingForegroundVideo = undefined;
    }
    record.message = networkInterrupted ? '网络条件变化，等待连接恢复后继续'
      : visibleStopReason === 'cancel' ? '已取消当前视频传输'
      : (background || visible) && interruptedVideo ? '视频等待打开应用继续传输'
      : stopped ? '已暂停，将在下次检查时继续'
      : record.targetBlocked ? record.targetBlocked
      : `备份未完成：${error instanceof Error && !(error instanceof TypeError) ? error.message : uploadError(error)}`;
  } finally {
    unsubscribeNetwork?.();
    if (timer) {clearTimeout(timer);}
    liveProgress = undefined;
    abort = undefined;
    await writeBackup(session, record);
    if (markerToClear && native.clearInterruptedVisible) {await native.clearInterruptedVisible(scope).catch(() => {});}
  }
}

export function runBackup(session: MobileSession, api: BrowseApi): Promise<void> {
  if (configuring || visibleStarting) {return Promise.resolve();}
  if (running) {return running;}
  stopped = false;
  running = performBackup(session, api, true).finally(() => {running = undefined;});
  return running;
}

export async function runVisibleBackup(session: MobileSession, api: BrowseApi): Promise<void> {
  if (visibleRunning && running) {return running;}
  if (visibleStarting) {throw new Error('视频传输正在启动');}
  visibleStarting = true;
  try {
    await stopBackup();
    const startedAfter = stopVersion;
    const record = await readBackup(session);
    if (!record.settings.videoEnabled || !record.settings.folder) {throw new Error('请先开启视频备份并选择目标文件夹');}
    if (record.targetBlocked) {throw new Error(record.targetBlocked);}
    await requestMediaAccess('video');
    await requestVisibleNotificationAccess();
    if (stopVersion !== startedAfter) {throw new Error('可见视频传输已停止');}
    await native.startVisible(visibleScope(session, record.settings.folder.id));
    if (stopVersion !== startedAfter) {
      await native.stopVisible(false);
      throw new Error('可见视频传输已停止');
    }
    stopped = false;
    visibleStopReason = undefined;
    visibleRunning = true;
    notify();
    running = performBackup(session, api, false, true).finally(async () => {
      const preserve = visibleStopReason === 'pause';
      try {await native.stopVisible(preserve);} finally {
        visibleRunning = false;
        visibleStopReason = undefined;
        running = undefined;
        notify();
      }
    });
    return running;
  } finally {visibleStarting = false;}
}

export async function pauseVisibleBackup() {
  if (!visibleRunning) {return;}
  visibleStopReason = 'pause';
  await stopBackup();
}

export async function cancelVisibleBackup() {
  if (!visibleRunning) {return;}
  visibleStopReason = 'cancel';
  await stopBackup();
}

export async function backgroundBackup() {
  if (configuring || visibleStarting) {return;}
  if (running) {return running;}
  if (foregroundApi) {return runBackup(foregroundApi.session, foregroundApi.api);}
  if (uiMounted) {return;}
  // Include credential loading in the lock so opening the UI cannot race a refresh.
  stopped = false;
  running = (async () => {
    const session = await loadSession();
    // Old sessions acquire the immutable account ID during UI authentication.
    if (session?.userId && !stopped) {await performBackup(session, new BrowseApi(session, () => {}), true);}
  })().finally(() => {running = undefined;});
  return running;
}
DeviceEventEmitter.addListener('Photo77BackupStop', () => {stopped = true; abort?.abort();});
DeviceEventEmitter.addListener('Photo77VisibleBackupAction', action => {
  if (!visibleRunning || action !== 'pause' && action !== 'cancel') {return;}
  visibleStopReason = action;
  stopped = true;
  abort?.abort();
});
