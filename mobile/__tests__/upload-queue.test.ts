import {loadQueue, pairMedia, saveQueue} from '../src/upload/queue';
import {NativeModules} from 'react-native';

jest.mock('@react-native-async-storage/async-storage', () => {
  const values = new Map<string, string>();
  return {getItem: (key: string) => Promise.resolve(values.get(key) ?? null),
    setItem: (key: string, value: string) => {values.set(key, value); return Promise.resolve();}};
});
jest.mock('react-native-blob-util', () => ({__esModule: true, default: {wrap: jest.fn()}}));
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
