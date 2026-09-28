import AsyncStorage from '@react-native-async-storage/async-storage';
import {NativeModules} from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import {ApiError} from '../auth/api';
import type {MobileSession} from '../auth/session';
import type {BrowseApi, Folder} from '../browse/api';

export type PickedFile = {path: string; name: string; mime: string; size: number; thumbnailPath?: string};
export type UploadItem = PickedFile & {
  id: string; folderId: string; folderName: string; status: 'waiting' | 'uploading' | 'success' | 'skipped' | 'failed';
  progress: number; message?: string; motion?: PickedFile;
};
const picker = NativeModules.Photo77Picker as {
  pick(): Promise<PickedFile[]>; deleteFile(path: string): Promise<boolean>;
};
export const pickMedia = () => picker.pick();
const keyFor = (session: MobileSession) => `upload-queue:v1:${encodeURIComponent(session.server)}:${encodeURIComponent(session.username)}`;
const blockedScopes = new Set<string>();
const writes = new Map<string, Promise<void>>();
const baseName = (name: string) => name.replace(/\.[^.]+$/, '').toLocaleLowerCase();
export const isCompleted = (item: UploadItem) => item.status === 'success' || item.status === 'skipped';
export async function deleteStagedFiles(items: UploadItem[]) {
  await Promise.all(items.flatMap(item => [item.path, item.thumbnailPath, item.motion?.path, item.motion?.thumbnailPath]
    .filter((path): path is string => !!path)).map(path => picker.deleteFile(path).catch(() => false)));
}
export function pairMedia(files: PickedFile[], folder: Folder): UploadItem[] {
  const stills = files.filter(file => ['image/jpeg', 'image/png', 'image/heic', 'image/heif'].includes(file.mime));
  const used = new Set<string>();
  const output: UploadItem[] = [];
  for (const file of files) {
    if (used.has(file.path)) {continue;}
    const motion = stills.includes(file) ? files.find(candidate =>
      !used.has(candidate.path) && candidate.mime === 'video/quicktime' && baseName(candidate.name) === baseName(file.name)) : undefined;
    if (motion) {used.add(motion.path);}
    if (file.mime === 'video/quicktime' && stills.some(still => baseName(still.name) === baseName(file.name))) {continue;}
    used.add(file.path);
    output.push({...file, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, folderId: folder.id,
      folderName: folder.name, status: 'waiting' as const, progress: 0, motion});
  }
  return output;
}
export async function loadQueue(session: MobileSession): Promise<UploadItem[]> {
  const key = keyFor(session);
  await writes.get(key)?.catch(() => {});
  const raw = await AsyncStorage.getItem(key);
  const items = raw ? JSON.parse(raw) as UploadItem[] : [];
  const pending = items.filter(item => !isCompleted(item));
  if (pending.length !== items.length) {
    await saveQueue(session, pending);
    await deleteStagedFiles(items.filter(isCompleted));
  }
  return pending.map(item => item.status === 'uploading' ? {...item, status: 'waiting', progress: 0, message: '应用已重启，待重新上传'} : item);
}
export async function saveQueue(session: MobileSession, items: UploadItem[]) {
  const key = keyFor(session);
  if (blockedScopes.has(key)) {return;}
  const previous = writes.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    if (!blockedScopes.has(key)) {await AsyncStorage.setItem(key, JSON.stringify(items));}
  });
  writes.set(key, next);
  await next;
}
export async function clearQueue(session: MobileSession) {
  const key = keyFor(session);
  blockedScopes.add(key);
  await writes.get(key)?.catch(() => {});
  const items = await loadQueue(session);
  await AsyncStorage.removeItem(keyFor(session));
  await deleteStagedFiles(items);
}
export function allowQueue(session: MobileSession) {blockedScopes.delete(keyFor(session));}

function decodeError(status: number, body: string): ApiError {
  let error: {code?: string; message?: string} = {};
  try {error = JSON.parse(body)?.error ?? {};} catch {}
  return new ApiError(status, error.code ?? '', error.message ?? `服务器错误 ${status}`);
}

export async function uploadOne(api: BrowseApi, item: UploadItem, progress: (value: number) => void): Promise<'success' | 'skipped'> {
  // A deleted or newly unreadable target fails early. The upload endpoint is
  // authoritative for write permission, including inherited shared grants.
  await api.request<Folder>(`/api/v1/folders/${encodeURIComponent(item.folderId)}`);
  const send = async (conflict: 'reject' | 'rename', retried = false): Promise<'success' | 'skipped'> => {
    const session = await api.validSession();
    // The ordinary upload route also extracts motion embedded in JPEG/HEIC.
    const live = !!item.motion;
    const body = [
      {name: 'folder_id', data: item.folderId}, {name: 'conflict', data: conflict},
      {name: 'file', filename: item.name, type: item.mime, data: ReactNativeBlobUtil.wrap(item.path)},
      ...(item.motion ? [{name: 'motion', filename: item.motion.name, type: item.motion.mime, data: ReactNativeBlobUtil.wrap(item.motion.path)}] : []),
    ];
    const route = live ? 'live-upload' : 'upload';
    const request = ReactNativeBlobUtil.config({timeout: 120000}).fetch('POST', `${session.server}/api/v1/photos/${route}`,
      {Authorization: `Bearer ${session.accessToken}`, Accept: 'application/json'}, body);
    request.uploadProgress({interval: 250}, (sent, total) => {if (total > 0) {progress(Math.min(99, Math.round(sent / total * 100)));}});
    const response = await request;
    const status = response.info().status;
    if (status === 201) {progress(100); return 'success';}
    const error = decodeError(status, response.data);
    if (status === 401 && !retried) {await api.retryMedia(); return send(conflict, true);}
    if (status === 409 && error.code === 'DUPLICATE_PHOTO') {return 'skipped';}
    if (status === 409 && error.code === 'NAME_CONFLICT' && conflict === 'reject') {return send('rename', retried);}
    throw error;
  };
  return send('reject');
}

export function uploadError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {return '登录已失效，请重新登录';}
    if (error.status === 403) {return '目标文件夹已无写入权限';}
    if (error.status === 413) {return '文件超过服务器大小限制';}
    if (error.status === 415 || error.status === 422) {return '服务器不支持或无法读取此媒体';}
    return error.message || `服务器错误 ${error.status}`;
  }
  return '上传中断，请检查网络后重试';
}
