import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import {NativeModules} from 'react-native';
import type {BrowseApi, Folder} from '../src/browse/api';
import {ApiError} from '../src/auth/api';
import {loadSession} from '../src/auth/session';
import {uploadOne} from '../src/upload/queue';
import {backgroundBackup, backupKey, configureBackup, disableBackup, enterBackupUI, leaveBackupUI, readBackup, runBackup, stopBackup} from '../src/backup/service';

jest.mock('@react-native-async-storage/async-storage', () => {
  const values = new Map<string, string>();
  return {getItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {values.set(key, value);}), clear: async () => values.clear()};
});
jest.mock('@react-native-community/netinfo', () => ({fetch: jest.fn()}));
jest.mock('react-native', () => ({
  NativeModules: {Photo77Backup: {scan: jest.fn(), stage: jest.fn(), schedule: jest.fn()}, Photo77Picker: {deleteFile: jest.fn()}},
  DeviceEventEmitter: {addListener: jest.fn()},
}));
jest.mock('../src/upload/queue', () => ({uploadOne: jest.fn(), uploadError: (error: Error) => error.message}));
jest.mock('../src/auth/session', () => ({loadSession: jest.fn()}));
jest.mock('../src/browse/api', () => ({BrowseApi: jest.fn()}));
const session = {server: 'http://192.168.1.5', username: 'alice', accessToken: 'a', accessExpiresAt: '', refreshToken: 'r', refreshExpiresAt: ''};
const folder: Folder = {id: 'f1', name: '相册', owner_id: 'u1', parent_id: null, is_shared: false};
const api = {} as BrowseApi;
const native = NativeModules.Photo77Backup;
const photo = {id: '1', uri: 'content://media/external/images/media/1', fingerprint: 'v1:1:20:100', name: 'a.jpg', mime: 'image/jpeg', size: 20};
const enabled = {enabled: true, wifiOnly: true, folder};

beforeEach(async () => {
  await stopBackup();
  leaveBackupUI();
  jest.clearAllMocks();
  await AsyncStorage.clear();
  native.schedule.mockResolvedValue(undefined);
  native.stage.mockResolvedValue('/staging/backup-current');
  NativeModules.Photo77Picker.deleteFile.mockResolvedValue(true);
  native.scan.mockImplementation(async (cursor: string) => cursor === '0' ? {items: [photo], next: '1'} : {items: [], next: cursor});
  (NetInfo.fetch as jest.Mock).mockResolvedValue({type: 'wifi', isConnected: true, isInternetReachable: true});
  (uploadOne as jest.Mock).mockResolvedValue('success');
  await configureBackup(session, enabled);
});

afterEach(async () => {await stopBackup();});

test('persists successful backups, skips them on the next scan, and cleans staging', async () => {
  await runBackup(session, api);
  await runBackup(session, api);
  expect(uploadOne).toHaveBeenCalledTimes(1);
  expect((await readBackup(session)).completed).toEqual({[photo.fingerprint]: true});
  expect(NativeModules.Photo77Picker.deleteFile).toHaveBeenCalledWith('/staging/backup-current');
});

test('does not access photos or upload on cellular until Wi-Fi-only is disabled', async () => {
  (NetInfo.fetch as jest.Mock).mockResolvedValue({type: 'cellular', isConnected: true, isInternetReachable: true});
  await runBackup(session, api);
  expect(native.scan).not.toHaveBeenCalled();
  await configureBackup(session, {...enabled, wifiOnly: false});
  await runBackup(session, api);
  expect(uploadOne).toHaveBeenCalledTimes(1);
});

test('stops before the next file if the connection switches to cellular', async () => {
  native.scan.mockResolvedValueOnce({items: [photo, {...photo, id: '2', fingerprint: 'second'}], next: '2'});
  (uploadOne as jest.Mock).mockImplementationOnce(async () => {
    (NetInfo.fetch as jest.Mock).mockResolvedValue({type: 'cellular', isConnected: true, isInternetReachable: true});
    return 'success';
  });
  await runBackup(session, api);
  expect(uploadOne).toHaveBeenCalledTimes(1);
  expect((await readBackup(session)).cursor).toBe('1');
});

test('a bad photo does not block later photos, and failed photos are retried', async () => {
  const second = {...photo, id: '2', fingerprint: 'second', name: 'b.jpg'};
  native.scan.mockImplementation(async (cursor: string) => cursor === '0' ? {items: [photo, second], next: '2'} : {items: [], next: cursor});
  (uploadOne as jest.Mock).mockRejectedValueOnce(new ApiError(415, '', '无法读取')).mockResolvedValue('success');
  await runBackup(session, api);
  expect((await readBackup(session)).completed).toEqual({second: true});
  expect((await readBackup(session)).message).toContain('1 张失败');
  await runBackup(session, api);
  expect(uploadOne).toHaveBeenCalledTimes(3);
  expect(Object.keys((await readBackup(session)).completed)).toHaveLength(2);
});

test('lost responses are not marked complete and retry can recognize a server duplicate', async () => {
  (uploadOne as jest.Mock).mockRejectedValueOnce(new TypeError('connection lost')).mockResolvedValueOnce('skipped');
  await runBackup(session, api);
  expect((await readBackup(session)).completed).toEqual({});
  await runBackup(session, api);
  expect((await readBackup(session)).completed[photo.fingerprint]).toBe(true);
});

test('scopes history by stable server identity and account; a new destination scans again', async () => {
  await runBackup(session, api);
  const alternate = {...session, server: 'http://100.90.1.5', profile: {id: session.server, addresses: []}};
  expect(backupKey(alternate)).toBe(backupKey(session));
  expect((await readBackup({...session, username: 'bob'})).settings.enabled).toBe(false);
  expect((await readBackup({...session, server: 'http://192.168.1.6'})).completed).toEqual({});
  await configureBackup(session, {...enabled, folder: {...folder, id: 'f2'}});
  await runBackup(session, api);
  expect(uploadOne).toHaveBeenCalledTimes(2);
});

test('concurrent triggers share one upload and disabling aborts it without marking success', async () => {
  let started!: () => void;
  const waiting = new Promise<void>(resolve => {started = resolve;});
  (uploadOne as jest.Mock).mockImplementationOnce((_api, _item, _progress, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')));
    started();
  }));
  const first = runBackup(session, api);
  const second = runBackup(session, api);
  await waiting;
  await disableBackup(session);
  await Promise.all([first, second]);
  expect(uploadOne).toHaveBeenCalledTimes(1);
  const record = await readBackup(session);
  expect(record.settings.enabled).toBe(false);
  expect(record.completed).toEqual({});
  await runBackup(session, api);
  expect(uploadOne).toHaveBeenCalledTimes(1);
});

test('headless startup is suppressed while the UI restores authentication', async () => {
  await enterBackupUI();
  await backgroundBackup();
  expect(loadSession).not.toHaveBeenCalled();
  leaveBackupUI();
  (loadSession as jest.Mock).mockResolvedValue(session);
  await backgroundBackup();
  expect(uploadOne).toHaveBeenCalledTimes(1);
});

test('denied library access reports the error and leaves photos retryable', async () => {
  native.scan.mockRejectedValueOnce(new Error('请允许访问全部照片'));
  await runBackup(session, api);
  expect(uploadOne).not.toHaveBeenCalled();
  expect((await readBackup(session)).message).toContain('请允许访问全部照片');
  expect((await readBackup(session)).completed).toEqual({});
});

test('scheduler failures leave backup disabled and visible to the user', async () => {
  native.schedule.mockRejectedValueOnce(new Error('scheduler unavailable'));
  await expect(configureBackup(session, enabled)).rejects.toThrow('scheduler unavailable');
  expect((await readBackup(session)).settings.enabled).toBe(false);
  expect(enabled.enabled).toBe(true);
});

test('resumes a partial scan at its persisted position after an interrupted upload', async () => {
  const second = {...photo, id: '2', fingerprint: 'second', name: 'b.jpg'};
  native.scan.mockImplementation(async (cursor: string) => ({
    items: [photo, second].filter(item => Number(item.id) > Number(cursor)), next: '2',
  }));
  (uploadOne as jest.Mock).mockResolvedValueOnce('success').mockRejectedValueOnce(new TypeError('offline'));
  await runBackup(session, api);
  expect((await readBackup(session)).cursor).toBe('1');
  native.scan.mockClear();
  await runBackup(session, api);
  expect(native.scan.mock.calls[0]).toEqual(['1']);
  expect(uploadOne).toHaveBeenCalledTimes(3);
  expect((await readBackup(session)).completed).toEqual({[photo.fingerprint]: true, second: true});
  expect((await readBackup(session)).cursor).toBe('0');
});
