import ReactNativeBlobUtil from 'react-native-blob-util';
import type {BrowseApi} from '../src/browse/api';
import {loadQueue, pairMedia, prepareUpload, saveQueue, uploadError, uploadOne} from '../src/upload/queue';
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

test('dated queues preserve each selected root, date and Live Photo pairing across relaunch', async () => {
  const capturedAt = new Date(2026, 9, 5, 0, 15).getTime();
  const items = pairMedia([
    {path: '/motion', name: 'IMG_1.MOV', mime: 'video/quicktime', size: 10, capturedAt: new Date(2026, 9, 6).getTime()},
    {path: '/still', name: 'IMG_1.HEIC', mime: 'image/heic', size: 20, capturedAt},
    {path: '/video', name: 'clip.mp4', mime: 'video/mp4', size: 30, addedAt: new Date(2025, 0, 2).getTime()},
    {path: '/unknown', name: 'unknown.png', mime: 'image/png', size: 40},
  ], folder, true);
  expect(items).toHaveLength(3);
  expect(items[0]).toMatchObject({folderName: '旅行/2026/10/05', dateArchive: {rootId: folder.id, parts: ['2026', '10', '05']}, motion: {path: '/motion'}});
  expect(items[1].folderName).toBe('旅行/2025/01/02');
  expect(items[2].folderName).toBe('旅行/日期未知');
  const session = {server: 'http://192.168.1.9', username: 'alice', accessToken: 'a', accessExpiresAt: '', refreshToken: 'r', refreshExpiresAt: ''};
  await saveQueue(session, items);
  expect(await loadQueue(session)).toEqual(items);
  expect(pairMedia([{path: '/direct', name: 'direct.jpg', mime: 'image/jpeg', size: 10}], folder, false)[0]).toMatchObject({folderId: folder.id, folderName: folder.name});
});

test('resolves date folders under the queued root, pins the leaf and retries the same folder', async () => {
  const request = jest.fn(async (path: string) => path.includes('?') ? {items: []} : folder);
  const createFolder = jest.fn(async (name: string, parentId: string) => ({...folder, id: `${parentId}/${name}`, parent_id: parentId, name}));
  const api = {request, createFolder} as unknown as BrowseApi;
  const item = pairMedia([{path: '/dated', name: 'dated.jpg', mime: 'image/jpeg', size: 20, capturedAt: new Date(2026, 9, 5).getTime()}], folder, true)[0];
  // The calendar path is saved at selection, even if later date metadata changes.
  const prepared = await prepareUpload(api, {...item, capturedAt: new Date(2026, 9, 6).getTime()}, new AbortController().signal);
  expect(prepared).toMatchObject({folderId: 'folder-1/2026/10/05', dateArchive: {resolved: true}});
  expect(createFolder.mock.calls).toEqual([['2026', 'folder-1'], ['10', 'folder-1/2026'], ['05', 'folder-1/2026/10']]);
  request.mockClear();
  expect(await prepareUpload(api, prepared, new AbortController().signal)).toBe(prepared);
  expect(request).not.toHaveBeenCalled();
  const response = Object.assign(Promise.resolve({info: () => ({status: 201})}), {uploadProgress: jest.fn()});
  const send: jest.Mock = jest.fn(() => response);
  (ReactNativeBlobUtil.config as jest.Mock).mockReturnValue({fetch: send});
  const uploadApi = {...api, validSession: jest.fn().mockResolvedValue({server: 'http://192.168.1.9', accessToken: 'a'})} as unknown as BrowseApi;
  await uploadOne(uploadApi, prepared, jest.fn());
  expect(send.mock.calls[0][3]).toContainEqual({name: 'folder_id', data: prepared.folderId});
});

test('unresolved or forbidden date destinations never upload bytes into the root', async () => {
  const item = pairMedia([{path: '/dated', name: 'dated.jpg', mime: 'image/jpeg', size: 20}], folder, true)[0];
  const api = {request: jest.fn().mockResolvedValue({...folder, effective_permission: 'read'}), createFolder: jest.fn()} as unknown as BrowseApi;
  (ReactNativeBlobUtil.config as jest.Mock).mockClear();
  await expect(uploadOne(api, item, jest.fn())).rejects.toThrow('日期目录尚未准备');
  await expect(prepareUpload(api, item, new AbortController().signal)).rejects.toMatchObject({status: 403});
  expect(api.createFolder).not.toHaveBeenCalled();
  expect(ReactNativeBlobUtil.config).not.toHaveBeenCalled();
});
