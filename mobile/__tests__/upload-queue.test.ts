import ReactNativeBlobUtil from 'react-native-blob-util';
import type {BrowseApi} from '../src/browse/api';
import {loadQueue, pairMedia, saveQueue, uploadError, uploadOne} from '../src/upload/queue';
import {ApiError} from '../src/auth/api';
import {NativeModules} from 'react-native';

jest.mock('@react-native-async-storage/async-storage', () => {
  const values = new Map<string, string>();
  return {getItem: (key: string) => Promise.resolve(values.get(key) ?? null),
    setItem: (key: string, value: string) => {values.set(key, value); return Promise.resolve();}};
});
jest.mock('react-native-blob-util', () => ({__esModule: true, default: {wrap: jest.fn(), config: jest.fn()}}));
jest.mock('react-native', () => ({NativeModules: {Photo77Picker: {pick: jest.fn(), deleteFile: jest.fn().mockResolvedValue(true)}}}));

const folder = {id: 'folder-1', owner_id: 'user-1', parent_id: null, name: '旅行', is_shared: false, effective_permission: 'write' as const};

test('pairs a selected MOV with its still even when the MOV appears first', () => {
  const items = pairMedia([
    {path: '/motion', name: 'IMG_1.MOV', mime: 'video/quicktime', size: 10},
    {path: '/still', name: 'IMG_1.HEIC', mime: 'image/heic', size: 20},
    {path: '/video', name: 'clip.mp4', mime: 'video/mp4', size: 30},
  ], folder);
  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({name: 'IMG_1.HEIC', motion: {path: '/motion'}, folderId: 'folder-1'});
  expect(items[1]).toMatchObject({name: 'clip.mp4', motion: undefined});
});

test('restores interrupted uploads and isolates queues by server', async () => {
  const first = {server: 'http://192.168.1.2', username: 'alice', accessToken: 'a', accessExpiresAt: '', refreshToken: 'r', refreshExpiresAt: ''};
  const second = {...first, server: 'http://192.168.1.3'};
  const item = {...pairMedia([{path: '/still', name: 'pic.jpg', mime: 'image/jpeg', size: 20}], folder)[0], status: 'uploading' as const};
  await saveQueue(first, [item]);
  expect(await loadQueue(first)).toMatchObject([{status: 'waiting', progress: 0}]);
  expect(await loadQueue(second)).toEqual([]);
});

test('removes completed uploads and staged files on relaunch while keeping failed work', async () => {
  const session = {server: 'http://192.168.1.4', username: 'alice', accessToken: 'a', accessExpiresAt: '', refreshToken: 'r', refreshExpiresAt: ''};
  const make = (name: string) => pairMedia([{path: `/${name}`, name, mime: 'image/jpeg', size: 20}], folder)[0];
  await saveQueue(session, [
    {...make('done.jpg'), status: 'success'},
    {...make('duplicate.jpg'), status: 'skipped'},
    {...make('retry.jpg'), status: 'failed'},
  ]);
  expect((await loadQueue(session)).map(item => item.name)).toEqual(['retry.jpg']);
  expect((await loadQueue(session)).map(item => item.name)).toEqual(['retry.jpg']);
  expect(NativeModules.Photo77Picker.deleteFile).toHaveBeenCalledWith('/done.jpg');
  expect(NativeModules.Photo77Picker.deleteFile).toHaveBeenCalledWith('/duplicate.jpg');
  expect(NativeModules.Photo77Picker.deleteFile).not.toHaveBeenCalledWith('/retry.jpg');
});

test('legacy queued uploads remain visible after migrating and switching to a VPN address', async () => {
  const legacy = {server: 'http://192.168.1.77', username: 'alice', accessToken: 'a', accessExpiresAt: '', refreshToken: 'r', refreshExpiresAt: ''};
  const items = pairMedia([{path: '/legacy-still', name: 'legacy.jpg', mime: 'image/jpeg', size: 20}], folder);
  await saveQueue(legacy, items);
  const switched = {...legacy, server: 'http://100.90.1.77', profile: {id: legacy.server, addresses: [
    {url: legacy.server, name: '家中', verified: true}, {url: 'http://100.90.1.77', name: '组网', verified: true},
  ]}};
  expect(await loadQueue(switched)).toEqual(items);
  await saveQueue(switched, [{...items[0], status: 'failed'}]);
  expect(await loadQueue(legacy)).toMatchObject([{status: 'failed'}]);
  expect(await loadQueue({...switched, username: 'bob'})).toEqual([]);
});


test('a lost upload response is not automatically replayed on a different address', async () => {
  const sent = Object.assign(Promise.reject(new TypeError('connection lost')), {uploadProgress: jest.fn()});
  const send = jest.fn(() => sent);
  (ReactNativeBlobUtil.config as jest.Mock).mockReturnValue({fetch: send});
  const api = {request: jest.fn().mockResolvedValue(folder), validSession: jest.fn().mockResolvedValue({server: 'http://100.90.1.5', accessToken: 'a'}), retryMedia: jest.fn()} as unknown as BrowseApi;
  const item = pairMedia([{path: '/upload', name: 'upload.jpg', mime: 'image/jpeg', size: 20}], folder)[0];
  await expect(uploadOne(api, item, jest.fn())).rejects.toThrow('connection lost');
  expect(send).toHaveBeenCalledTimes(1);
  expect(api.retryMedia).not.toHaveBeenCalled();
});

test('backup cancellation aborts the active upload and never starts another request', async () => {
  const controller = new AbortController();
  let rejectRequest!: (error: Error) => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => {started = resolve;});
  const request = Object.assign(new Promise((_resolve, reject) => {rejectRequest = reject;}), {
    uploadProgress: jest.fn(), cancel: jest.fn(() => rejectRequest(new Error('cancelled'))),
  });
  const send = jest.fn(() => {started(); return request;});
  (ReactNativeBlobUtil.config as jest.Mock).mockReturnValue({fetch: send});
  const api = {request: jest.fn().mockResolvedValue(folder), validSession: jest.fn().mockResolvedValue({server: 'http://192.168.1.5', accessToken: 'a'})} as unknown as BrowseApi;
  const item = pairMedia([{path: '/upload', name: 'upload.jpg', mime: 'image/jpeg', size: 20}], folder)[0];
  const result = uploadOne(api, item, jest.fn(), controller.signal);
  await waiting;
  controller.abort();
  await expect(result).rejects.toThrow('cancelled');
  expect(request.cancel).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
});

test('video upload can use a longer timeout than the ordinary upload', async () => {
  const response = Object.assign(Promise.resolve({info: () => ({status: 201})}), {uploadProgress: jest.fn()});
  (ReactNativeBlobUtil.config as jest.Mock).mockReturnValue({fetch: jest.fn(() => response)});
  const api = {request: jest.fn().mockResolvedValue(folder), validSession: jest.fn().mockResolvedValue({server: 'http://192.168.1.5', accessToken: 'a'})} as unknown as BrowseApi;
  const item = pairMedia([{path: '/clip', name: 'clip.mp4', mime: 'video/mp4', size: 50}], folder)[0];
  await expect(uploadOne(api, item, jest.fn(), undefined, 30 * 60 * 1000)).resolves.toBe('success');
  expect(ReactNativeBlobUtil.config).toHaveBeenCalledWith({timeout: 30 * 60 * 1000, followRedirect: false});
});

test('server disk-full response names the condition for backup retry', () => {
  expect(uploadError(new ApiError(507, 'STORAGE_FULL', 'server storage is full'))).toContain('服务器存储空间不足');
});

test('cancelled work stays cancelled on relaunch and keeps staged files for retry', async () => {
  const session = {server: 'http://192.168.1.6', username: 'alice', accessToken: 'a', accessExpiresAt: '', refreshToken: 'r', refreshExpiresAt: ''};
  const item = {...pairMedia([{path: '/cancelled', name: 'cancelled.jpg', mime: 'image/jpeg', size: 20}], folder)[0], status: 'cancelled' as const};
  (NativeModules.Photo77Picker.deleteFile as jest.Mock).mockClear();
  await saveQueue(session, [item]); expect(await loadQueue(session)).toMatchObject([{status: 'cancelled'}]);
  expect(NativeModules.Photo77Picker.deleteFile).not.toHaveBeenCalled();
});

test('cancelling before folder lookup finishes never starts native transfer', async () => {
  const controller = new AbortController(); let finish!: () => void;
  const api = {request: jest.fn(() => new Promise<void>(resolve => {finish = resolve;})), validSession: jest.fn()} as unknown as BrowseApi;
  (ReactNativeBlobUtil.config as jest.Mock).mockClear();
  const item = pairMedia([{path: '/a', name: 'a.jpg', mime: 'image/jpeg', size: 20}], folder)[0];
  const result = uploadOne(api, item, jest.fn(), controller.signal); controller.abort(); finish();
  await expect(result).rejects.toThrow('取消'); expect(ReactNativeBlobUtil.config).not.toHaveBeenCalled();
});
