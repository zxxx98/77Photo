import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import {DeviceEventEmitter, NativeModules, PermissionsAndroid, Platform} from 'react-native';
import {loadSession, type MobileSession} from '../auth/session';
import {ApiError} from '../auth/api';
import {BrowseApi, type Folder} from '../browse/api';
import {uploadError, uploadOne, type UploadItem} from '../upload/queue';

export type BackupSettings = {enabled: boolean; wifiOnly: boolean; folder: Folder | null};
export type LibraryPhoto = {id: string; uri: string; fingerprint: string; name: string; mime: string; size: number};
type BackupRecord = {settings: BackupSettings; completed: Record<string, true>; cursor?: string; lastRun?: string; message?: string};
const native = NativeModules.Photo77Backup as {
  schedule(enabled: boolean, wifiOnly: boolean): Promise<void>;
  scan(after: string): Promise<{items: LibraryPhoto[]; next: string}>;
  stage(uri: string): Promise<string>;
};
const defaults = (): BackupRecord => ({settings: {enabled: false, wifiOnly: true, folder: null}, completed: {}});
export const backupKey = (session: MobileSession) => `backup:v1:${encodeURIComponent(session.profile?.id ?? session.server)}:${encodeURIComponent(session.username)}`;
let running: Promise<void> | undefined;
let stopped = false;
let abort: AbortController | undefined;
let configuring = false;
let uiMounted = false;
let foregroundApi: {api: BrowseApi; session: MobileSession} | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
export const subscribeBackup = (listener: () => void) => {listeners.add(listener); return () => {listeners.delete(listener);};};
export async function readBackup(session: MobileSession): Promise<BackupRecord> {
  const raw = await AsyncStorage.getItem(backupKey(session));
  return raw ? JSON.parse(raw) as BackupRecord : defaults();
}
async function writeBackup(session: MobileSession, record: BackupRecord) {
  await AsyncStorage.setItem(backupKey(session), JSON.stringify(record));
  notify();
}
export async function requestPhotoAccess() {
  if (Platform.OS !== 'android') {throw new Error('自动备份目前仅支持 Android');}
  const permission = Number(Platform.Version) >= 33 ? PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES : PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE;
  if (await PermissionsAndroid.check(permission)) {return;}
  const result = Number(Platform.Version) >= 34 ? (await PermissionsAndroid.requestMultiple([
    permission, PermissionsAndroid.PERMISSIONS.READ_MEDIA_VISUAL_USER_SELECTED,
  ]))[permission] : await PermissionsAndroid.request(permission);
  if (result !== PermissionsAndroid.RESULTS.GRANTED) {throw new Error('请在系统设置中允许访问全部照片，再开启自动备份');}
}
export async function stopBackup() {
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
  if (record.settings.enabled) {await native.schedule(true, record.settings.wifiOnly);}
}
export async function configureBackup(session: MobileSession, settings: BackupSettings) {
  configuring = true;
  try {
    await stopBackup();
    const record = await readBackup(session);
    // A different destination must get its own full scan.
    if (record.settings.folder?.id !== settings.folder?.id) {record.completed = {}; record.cursor = '0';}
    record.settings = {...settings};
    record.message = settings.enabled ? '等待自动备份' : '自动备份已关闭';
    await writeBackup(session, record);
    try {await native.schedule(settings.enabled, settings.wifiOnly);}
    catch (error) {
      record.settings.enabled = false;
      record.message = '无法安排后台备份，请重新开启';
      await writeBackup(session, record);
      throw error;
    }
  } finally {configuring = false;}
}
export async function disableBackup(session: MobileSession) {
  const record = await readBackup(session);
  await configureBackup(session, {...record.settings, enabled: false});
}
export function networkAllowsBackup(settings: BackupSettings, network: {isConnected: boolean | null; isInternetReachable: boolean | null; type: string}) {
  return network.isConnected === true && network.isInternetReachable !== false && (!settings.wifiOnly || network.type === 'wifi');
}

async function performBackup(session: MobileSession, api: BrowseApi) {
  const record = await readBackup(session);
  if (!record.settings.enabled || !record.settings.folder) {return;}
  const deadline = Date.now() + 90000;
  abort = new AbortController();
  const timer = setTimeout(() => {stopped = true; abort?.abort();}, 180000);
  let cursor = record.cursor ?? '0';
  let count = 0;
  let failures = 0;
  let lastError = '';
  try {
    if (!networkAllowsBackup(record.settings, await NetInfo.fetch())) {
      record.message = record.settings.wifiOnly ? '等待 Wi-Fi 连接' : '等待网络连接';
      return;
    }
    record.message = '正在扫描照片…';
    await writeBackup(session, record);
    while (!stopped && Date.now() < deadline) {
      const page = await native.scan(cursor);
      if (!page.items.length) {
        record.cursor = '0';
        record.lastRun = new Date().toISOString();
        record.message = failures ? `本次备份 ${count} 张，${failures} 张失败，将自动重试：${lastError}` : `备份检查完成，本次备份 ${count} 张照片`;
        return;
      }
      for (const photo of page.items) {
        if (stopped || Date.now() >= deadline) {record.message = '已暂停，将在下次检查时继续'; return;}
        if (record.completed[photo.fingerprint]) {record.cursor = photo.id; continue;}
        if (!networkAllowsBackup(record.settings, await NetInfo.fetch())) {record.message = '网络条件不满足，等待下次检查'; return;}
        let path: string | undefined;
        try {
          path = await native.stage(photo.uri);
          if (stopped) {return;}
          const item: UploadItem = {...photo, path, id: photo.fingerprint, folderId: record.settings.folder.id,
            folderName: record.settings.folder.name, status: 'waiting', progress: 0};
          record.message = `正在备份：${photo.name}`;
          await writeBackup(session, record);
          await uploadOne(api, item, () => {}, abort.signal);
          record.completed[photo.fingerprint] = true;
          record.cursor = photo.id;
          count++;
          await writeBackup(session, record);
        } catch (error) {
          if (stopped || error instanceof TypeError || (error instanceof ApiError && [401, 403, 404, 429].includes(error.status))) {throw error;}
          failures++;
          lastError = `${photo.name}：${uploadError(error)}`;
          record.cursor = photo.id;
        } finally {
          if (path) {await NativeModules.Photo77Picker.deleteFile(path).catch(() => {});}
        }
      }
      if (page.next === cursor) {throw new Error('相册扫描未能继续，请重新打开应用');}
      cursor = page.next;
    }
    record.message = '已暂停，将在下次检查时继续';
  } catch (error) {
    record.message = stopped ? '已暂停，将在下次检查时继续' : `备份未完成：${error instanceof Error && !(error instanceof TypeError) ? error.message : uploadError(error)}`;
  } finally {clearTimeout(timer); abort = undefined; await writeBackup(session, record);}
}

export function runBackup(session: MobileSession, api: BrowseApi): Promise<void> {
  if (configuring) {return Promise.resolve();}
  if (running) {return running;}
  stopped = false;
  running = performBackup(session, api).finally(() => {running = undefined;});
  return running;
}

export async function backgroundBackup() {
  if (configuring) {return;}
  if (running) {return running;}
  if (foregroundApi) {return runBackup(foregroundApi.session, foregroundApi.api);}
  if (uiMounted) {return;}
  // Include credential loading in the lock so opening the UI cannot race a refresh.
  stopped = false;
  running = (async () => {
    const session = await loadSession();
    if (session && !stopped) {await performBackup(session, new BrowseApi(session, () => {}));}
  })().finally(() => {running = undefined;});
  return running;
}
DeviceEventEmitter.addListener('Photo77BackupStop', () => {stopped = true; abort?.abort();});
