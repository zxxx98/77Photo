import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import {NativeModules, PermissionsAndroid, Platform} from 'react-native';
import type {BrowseApi, Folder} from '../src/browse/api';
import {ApiError} from '../src/auth/api';
import {loadSession} from '../src/auth/session';
import {uploadOne} from '../src/upload/queue';
import {backgroundBackup, backupKey, cancelVisibleBackup, configureBackup, disableBackup, enterBackupUI, leaveBackupUI,
  pauseVisibleBackup, readBackup, retryBlockedBackup, runBackup, runVisibleBackup, stopBackup} from '../src/backup/service';

jest.mock('@react-native-async-storage/async-storage', () => {
  const values = new Map<string, string>();
  return {getItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {values.set(key, value);}), clear: async () => values.clear()};
});
jest.mock('@react-native-community/netinfo', () => ({fetch: jest.fn(), addEventListener: jest.fn(() => jest.fn())}));
jest.mock('react-native', () => ({
  NativeModules: {Photo77Backup: {scan: jest.fn(), stage: jest.fn(), schedule: jest.fn(), startVisible: jest.fn(),
    updateVisible: jest.fn(), stopVisible: jest.fn(), interruptedVisible: jest.fn(), clearInterruptedVisible: jest.fn()}, Photo77Picker: {deleteFile: jest.fn()}},
  DeviceEventEmitter: {addListener: jest.fn()},
  Platform: {OS: 'android', Version: 31},
  PermissionsAndroid: {PERMISSIONS: {READ_EXTERNAL_STORAGE: 'read', READ_MEDIA_IMAGES: 'images', READ_MEDIA_VIDEO: 'videos',
    READ_MEDIA_VISUAL_USER_SELECTED: 'selected', POST_NOTIFICATIONS: 'notifications'}, RESULTS: {GRANTED: 'granted'},
    check: jest.fn().mockResolvedValue(true), request: jest.fn().mockResolvedValue('granted'), requestMultiple: jest.fn()},
}));
jest.mock('../src/upload/queue', () => ({uploadOne: jest.fn(), uploadError: (error: Error) => error.message}));
jest.mock('../src/auth/session', () => ({loadSession: jest.fn()}));
jest.mock('../src/browse/api', () => ({BrowseApi: jest.fn()}));
const session = {server: 'http://192.168.1.5', username: 'alice', accessToken: 'a', accessExpiresAt: '', refreshToken: 'r', refreshExpiresAt: ''};
const folder: Folder = {id: 'f1', name: '相册', owner_id: 'u1', parent_id: null, is_shared: false};
const api = {request: jest.fn(), createFolder: jest.fn()} as unknown as BrowseApi;
const native = NativeModules.Photo77Backup;
const photo = {id: '1', uri: 'content://media/external/images/media/1', fingerprint: 'v1:1:20:100', name: 'a.jpg', mime: 'image/jpeg', size: 20};
const enabled = {enabled: true, wifiOnly: true, folder};

beforeEach(async () => {
  await stopBackup();
  leaveBackupUI();
  jest.clearAllMocks();
  (Platform as {Version: number}).Version = 31;
  await AsyncStorage.clear();
  native.schedule.mockResolvedValue(undefined);
  native.stage.mockResolvedValue('/staging/backup-current');
  native.startVisible.mockResolvedValue(undefined);
  native.updateVisible.mockResolvedValue(undefined);
  native.stopVisible.mockResolvedValue(undefined);
  native.interruptedVisible.mockResolvedValue(null);
  native.clearInterruptedVisible.mockResolvedValue(undefined);
  (api.request as jest.Mock).mockResolvedValue(folder);
  (PermissionsAndroid.check as jest.Mock).mockResolvedValue(true);
  (PermissionsAndroid.request as jest.Mock).mockResolvedValue('granted');
  (jest.requireMock('../src/browse/api').BrowseApi as jest.Mock).mockImplementation(() => ({request: jest.fn().mockResolvedValue(folder)}));
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

function dateFolderApi() {
  const folders: Folder[] = [];
  (api.request as jest.Mock).mockImplementation(async (path: string) => {
    if (!path.includes('?')) {return folder;}
    const parentId = new URL(`http://server${path}`).searchParams.get('parent_id');
    return {items: folders.filter(entry => entry.parent_id === parentId)};
  });
  (api.createFolder as jest.Mock).mockImplementation(async (name: string, parentId: string) => {
    const created = {...folder, id: `${parentId}/${name}`, parent_id: parentId, name};
    folders.push(created);
    return created;
  });
}

test('new configurations default to date folders while existing configurations stay flat', async () => {
  expect((await readBackup({...session, username: 'new-user'})).settings.dateFolders).toBe(true);
  const record = await readBackup(session);
  delete record.settings.dateFolders;
  await AsyncStorage.setItem(backupKey(session), JSON.stringify(record));
  expect((await readBackup(session)).settings.dateFolders).toBe(false);
});

test('photos upload to their date folders and changing layout keeps separate history', async () => {
  await runBackup(session, api);
  dateFolderApi();
  native.scan.mockImplementation(async (cursor: string) => cursor === '0'
    ? {items: [{...photo, capturedAt: new Date(2026, 9, 5).getTime()}], next: '1'} : {items: [], next: cursor});
  await configureBackup(session, {...enabled, dateFolders: true});
  expect((await readBackup(session)).completed).toEqual({});
  await runBackup(session, api);
  expect(uploadOne).toHaveBeenLastCalledWith(api, expect.objectContaining({folderId: 'f1/2026/10/05'}), expect.any(Function), expect.anything(), undefined);
  expect(api.createFolder).toHaveBeenCalledTimes(3);
  await runBackup(session, api);
  expect(uploadOne).toHaveBeenCalledTimes(2);
  await configureBackup(session, enabled);
  await runBackup(session, api);
  await configureBackup(session, {...enabled, dateFolders: true});
  await runBackup(session, api);
  expect(uploadOne).toHaveBeenCalledTimes(2);
});

test('photo and video backup share date directories but keep separate completion records', async () => {
  dateFolderApi();
  const capturedAt = new Date(2026, 0, 2).getTime();
  const video = {...photo, id: '7', fingerprint: 'video:7', name: 'clip.mp4', mime: 'video/mp4', capturedAt};
  native.scan.mockImplementation(async (cursor: string, kind: string) => cursor === '0'
    ? {items: [kind === 'photo' ? {...photo, capturedAt} : video], next: kind === 'photo' ? '1' : '7'} : {items: [], next: cursor});
  await configureBackup(session, {...enabled, dateFolders: true, videoEnabled: true});
  await runBackup(session, api);
  expect((uploadOne as jest.Mock).mock.calls.map(call => call[1].folderId)).toEqual(['f1/2026/01/02', 'f1/2026/01/02']);
  expect(api.createFolder).toHaveBeenCalledTimes(3);
  expect((await readBackup(session)).completed).toEqual({[photo.fingerprint]: true, [video.fingerprint]: true});
});

test('a date folder permission failure stops before staging and never uploads to the root', async () => {
  dateFolderApi();
  (api.createFolder as jest.Mock).mockRejectedValueOnce(new ApiError(403, 'WRITE_FORBIDDEN', 'forbidden'));
  await configureBackup(session, {...enabled, dateFolders: true});
  await runBackup(session, api);
  expect(native.stage).not.toHaveBeenCalled();
  expect(uploadOne).not.toHaveBeenCalled();
  expect((await readBackup(session)).targetBlocked).toContain('无写入权限');
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

test('a bad photo does not block later photos, and a manual retry can upload it', async () => {
  const second = {...photo, id: '2', fingerprint: 'second', name: 'b.jpg'};
  native.scan.mockImplementation(async (cursor: string) => cursor === '0' ? {items: [photo, second], next: '2'} : {items: [], next: cursor});
  (uploadOne as jest.Mock).mockRejectedValueOnce(new ApiError(415, '', '无法读取')).mockResolvedValue('success');
  await runBackup(session, api);
  expect((await readBackup(session)).completed).toEqual({second: true});
  expect((await readBackup(session)).message).toContain('1 项未完成');
  await retryBlockedBackup(session);
  await runBackup(session, api);
  expect(uploadOne).toHaveBeenCalledTimes(3);
  expect(Object.keys((await readBackup(session)).completed)).toHaveLength(2);
});

test('lost responses are not marked complete and a later retry recognizes a server duplicate', async () => {
  (uploadOne as jest.Mock).mockRejectedValueOnce(new TypeError('connection lost')).mockResolvedValueOnce('skipped');
  await runBackup(session, api);
  expect((await readBackup(session)).completed).toEqual({});
  const later = Date.now() + 61000;
  const now = jest.spyOn(Date, 'now').mockReturnValue(later);
  try {await runBackup(session, api);} finally {now.mockRestore();}
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
  await configureBackup(session, enabled);
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
  (loadSession as jest.Mock).mockResolvedValue({...session, userId: 'user-1'});
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
  const later = Date.now() + 61000;
  const now = jest.spyOn(Date, 'now').mockReturnValue(later);
  try {await runBackup(session, api);} finally {now.mockRestore();}
  expect(native.scan.mock.calls[0]).toEqual(['1', 'photo']);
  expect(uploadOne).toHaveBeenCalledTimes(3);
  expect((await readBackup(session)).completed).toEqual({[photo.fingerprint]: true, second: true});
  expect((await readBackup(session)).cursor).toBe('0');
});

test('video backup is opt in and keeps a separate cursor and completion history', async () => {
  const video = {id: '7', uri: 'content://media/external/video/media/7', fingerprint: 'video:external:v1:7:50:100',
    name: 'clip.mp4', mime: 'video/mp4', size: 50};
  native.scan.mockImplementation(async (cursor: string, kind: string) => {
    const items = kind === 'video' ? [video] : [photo];
    return {items: items.filter(item => Number(item.id) > Number(cursor)), next: items[0].id};
  });
  await runBackup(session, api);
  expect(native.scan.mock.calls.every((call: string[]) => call[1] === 'photo')).toBe(true);
  await configureBackup(session, {...enabled, videoEnabled: true});
  await runBackup(session, api);
  const record = await readBackup(session);
  expect(record.completed[photo.fingerprint]).toBe(true);
  expect(record.completed[video.fingerprint]).toBe(true);
  expect(record.cursor).toBe('0');
  expect(record.videoCursor).toBe('0');
  expect(record.lastVideoRun).toBeDefined();
  expect(uploadOne).toHaveBeenCalledTimes(2);
});

test('denied video access leaves photos working and video scan incomplete', async () => {
  native.scan.mockImplementation(async (cursor: string, kind: string) => {
    if (kind === 'video') {throw new Error('请允许访问全部视频');}
    return cursor === '0' ? {items: [photo], next: '1'} : {items: [], next: cursor};
  });
  await configureBackup(session, {...enabled, videoEnabled: true});
  await runBackup(session, api);
  const record = await readBackup(session);
  expect(record.completed[photo.fingerprint]).toBe(true);
  expect(record.lastVideoRun).toBeUndefined();
  expect(record.message).toContain('请允许访问全部视频');
});

test('unsupported video is reported and never counted complete', async () => {
  const video = {id: '7', uri: 'content://media/external/video/media/7', fingerprint: 'video:external:v1:7:50:100',
    name: 'clip.mov', mime: 'video/quicktime', size: 50};
  native.scan.mockImplementation(async (cursor: string, kind: string) => kind === 'video' && cursor === '0'
    ? {items: [video], next: '7'} : {items: [], next: cursor});
  await configureBackup(session, {...enabled, videoEnabled: true});
  await runBackup(session, api);
  const record = await readBackup(session);
  expect(record.completed).toEqual({});
  expect(record.lastVideoRun).toBeUndefined();
  expect(record.message).toContain('暂不支持');
});

test('server size rejection waits for an explicit retry', async () => {
  (uploadOne as jest.Mock).mockRejectedValueOnce(new ApiError(413, 'UPLOAD_TOO_LARGE', 'too large'));
  await runBackup(session, api);
  expect((await readBackup(session)).blocked?.[photo.fingerprint]).toContain('too large');
  await runBackup(session, api);
  expect(uploadOne).toHaveBeenCalledTimes(1);
  await retryBlockedBackup(session);
  await runBackup(session, api);
  expect(uploadOne).toHaveBeenCalledTimes(2);
  expect((await readBackup(session)).blocked).toEqual({});
});

test('a transient video upload backs off without stopping photo backup', async () => {
  const video = {id: '7', uri: 'content://media/external/video/media/7', fingerprint: 'video:external:v1:7:50:100',
    name: 'clip.webm', mime: 'video/webm', size: 50};
  native.scan.mockImplementation(async (cursor: string, kind: string) => {
    const items = kind === 'video' ? [video] : [photo];
    return {items: items.filter(item => Number(item.id) > Number(cursor)), next: items[0].id};
  });
  (uploadOne as jest.Mock).mockResolvedValueOnce('success').mockRejectedValueOnce(new TypeError('offline'));
  await configureBackup(session, {...enabled, videoEnabled: true});
  await runBackup(session, api);
  const record = await readBackup(session);
  expect(record.completed[photo.fingerprint]).toBe(true);
  expect(record.completed[video.fingerprint]).toBeUndefined();
  expect(record.pendingForegroundVideo).toBeUndefined();
  expect(record.retry?.video?.until).toBeGreaterThan(Date.now());
  expect(record.lastRun).toBeDefined();
  expect(record.lastVideoRun).toBeUndefined();
  await runBackup(session, api);
  expect(uploadOne).toHaveBeenCalledTimes(2);
});

test('migrates legacy photo fingerprint without uploading it again', async () => {
  await runBackup(session, api);
  const migrated = {...photo, fingerprint: 'photo:external:v1:1:20:100', legacyFingerprint: photo.fingerprint};
  native.scan.mockImplementation(async (cursor: string) => cursor === '0' ? {items: [migrated], next: '1'} : {items: [], next: cursor});
  await runBackup(session, api);
  expect(uploadOne).toHaveBeenCalledTimes(1);
  expect((await readBackup(session)).completed).toEqual({[migrated.fingerprint]: true});
});

test('migrates legacy history once to the immutable account ID', async () => {
  await runBackup(session, api);
  const identified = {...session, userId: folder.owner_id};
  expect(backupKey(identified)).not.toBe(backupKey(session));
  expect((await readBackup(identified)).completed).toEqual({});
  await runBackup(identified, api);
  expect((await readBackup(identified)).completed[photo.fingerprint]).toBe(true);
  expect(uploadOne).toHaveBeenCalledTimes(1);
  expect((await readBackup({...session, userId: 'user-2'})).completed).toEqual({});
});

test('a recreated username cannot inherit old completion history on first migration', async () => {
  await runBackup(session, api);
  const differentAccount = {...session, userId: 'new-user'};
  expect((await readBackup(differentAccount)).completed).toEqual({});
  await runBackup(differentAccount, api);
  expect(uploadOne).toHaveBeenCalledTimes(2);
});

test('a transferred folder cannot confer legacy completion history on its new owner', async () => {
  await runBackup(session, api);
  const newOwner = {...session, userId: 'new-user'};
  (api.request as jest.Mock).mockResolvedValue({...folder, owner_id: newOwner.userId});
  await runBackup(newOwner, api);
  expect(uploadOne).toHaveBeenCalledTimes(2);
  expect((await readBackup(newOwner)).completed[photo.fingerprint]).toBe(true);
  // A later sign-in by the original account can still claim its own old record.
  (api.request as jest.Mock).mockResolvedValue(folder);
  const originalOwner = {...session, userId: folder.owner_id};
  await runBackup(originalOwner, api);
  expect(uploadOne).toHaveBeenCalledTimes(2);
  expect((await readBackup(originalOwner)).completed[photo.fingerprint]).toBe(true);
});

test('a user-started visible video transfer keeps a notification and can pause without auto retry', async () => {
  const video = {id: '7', uri: 'content://media/external/video/media/7', fingerprint: 'video:external:v1:7:50:100',
    name: 'clip.mp4', mime: 'video/mp4', size: 50};
  native.scan.mockImplementation(async (cursor: string, kind: string) => kind === 'video' && cursor === '0'
    ? {items: [video], next: '7'} : {items: [], next: cursor});
  await configureBackup(session, {...enabled, enabled: false, videoEnabled: true});
  let started!: () => void;
  const waiting = new Promise<void>(resolve => {started = resolve;});
  (uploadOne as jest.Mock).mockImplementationOnce((_api, _item, _progress, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')));
    started();
  }));
  const task = runVisibleBackup(session, api);
  await waiting;
  expect(native.startVisible).toHaveBeenCalledTimes(1);
  expect(native.updateVisible).toHaveBeenCalledWith(video.name, -1, video.fingerprint);
  await pauseVisibleBackup();
  await task;
  expect(native.stopVisible).toHaveBeenCalledWith(true);
  expect((await readBackup(session)).pendingForegroundVideo).toBe(video.fingerprint);
  await runBackup(session, api);
  expect(uploadOne).toHaveBeenCalledTimes(1);
});

test('cancelling visible video requires an explicit retry before automatic upload', async () => {
  const video = {id: '7', uri: 'content://media/external/video/media/7', fingerprint: 'video:external:v1:7:50:100',
    name: 'clip.mp4', mime: 'video/mp4', size: 50};
  native.scan.mockImplementation(async (cursor: string, kind: string) => kind === 'video' && cursor === '0'
    ? {items: [video], next: '7'} : {items: [], next: cursor});
  await configureBackup(session, {...enabled, enabled: false, videoEnabled: true});
  let started!: () => void;
  const waiting = new Promise<void>(resolve => {started = resolve;});
  (uploadOne as jest.Mock).mockImplementationOnce((_api, _item, _progress, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')));
    started();
  }));
  const task = runVisibleBackup(session, api);
  await waiting;
  await cancelVisibleBackup();
  await task;
  const record = await readBackup(session);
  expect(record.blocked?.[video.fingerprint]).toContain('已取消');
  expect(record.pendingForegroundVideo).toBeUndefined();
  expect(native.stopVisible).toHaveBeenCalledWith(false);
});

test('a notification cancel survives a process restart before JS records it', async () => {
  const video = {id: '7', uri: 'content://media/external/video/media/7', fingerprint: 'video:external:v1:7:50:100',
    name: 'clip.mp4', mime: 'video/mp4', size: 50};
  native.scan.mockImplementation(async (cursor: string, kind: string) => kind === 'video' && cursor === '0'
    ? {items: [video], next: '7'} : {items: [], next: cursor});
  await configureBackup(session, {...enabled, enabled: false, videoEnabled: true});
  native.interruptedVisible.mockResolvedValue({fingerprint: video.fingerprint, action: 'cancel'});
  await runBackup(session, api);
  expect(uploadOne).not.toHaveBeenCalled();
  expect((await readBackup(session)).blocked?.[video.fingerprint]).toContain('已取消');
  expect(native.clearInterruptedVisible).toHaveBeenCalledTimes(1);
});

test('sign-out or disabling during foreground-service startup stops the new service', async () => {
  await configureBackup(session, {...enabled, enabled: false, videoEnabled: true});
  let starting!: () => void;
  let finishStart!: () => void;
  const started = new Promise<void>(resolve => {starting = resolve;});
  native.startVisible.mockImplementationOnce(() => new Promise<void>(resolve => {finishStart = resolve; starting();}));
  const task = runVisibleBackup(session, api);
  await started;
  await stopBackup();
  finishStart();
  await expect(task).rejects.toThrow('已停止');
  expect(native.stopVisible).toHaveBeenCalledWith(false);
  expect(uploadOne).not.toHaveBeenCalled();
});

test('switching from Wi-Fi to cellular cancels an active video without marking it complete', async () => {
  const video = {id: '7', uri: 'content://media/external/video/media/7', fingerprint: 'video:external:v1:7:50:100',
    name: 'clip.mp4', mime: 'video/mp4', size: 50};
  native.scan.mockImplementation(async (cursor: string, kind: string) => kind === 'video' && cursor === '0'
    ? {items: [video], next: '7'} : {items: [], next: cursor});
  await configureBackup(session, {...enabled, enabled: false, videoEnabled: true});
  let started!: () => void;
  const waiting = new Promise<void>(resolve => {started = resolve;});
  (uploadOne as jest.Mock).mockImplementationOnce((_api, _item, _progress, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('network changed')));
    started();
  }));
  const task = runBackup(session, api);
  await waiting;
  const callback = (NetInfo.addEventListener as jest.Mock).mock.calls[0][0];
  callback({type: 'cellular', isConnected: true, isInternetReachable: true});
  await task;
  const record = await readBackup(session);
  expect(record.completed).toEqual({});
  expect(record.pendingForegroundVideo).toBeUndefined();
  expect(record.message).toContain('网络条件变化');
});

test('the active background video is persisted before upload and is not blindly restarted after interruption', async () => {
  const video = {id: '7', uri: 'content://media/external/video/media/7', fingerprint: 'video:external:v1:7:50:100',
    name: 'large.mp4', mime: 'video/mp4', size: 50};
  native.scan.mockImplementation(async (cursor: string, kind: string) => kind === 'video' && cursor === '0'
    ? {items: [video], next: '7'} : {items: [], next: cursor});
  await configureBackup(session, {...enabled, enabled: false, videoEnabled: true});
  let started!: () => void;
  const waiting = new Promise<void>(resolve => {started = resolve;});
  (uploadOne as jest.Mock).mockImplementationOnce((_api, _item, _progress, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('job stopped')));
    started();
  }));
  const task = runBackup(session, api);
  await waiting;
  expect((await readBackup(session)).pendingForegroundVideo).toBe(video.fingerprint);
  await stopBackup();
  await task;
  await runBackup(session, api);
  expect(uploadOne).toHaveBeenCalledTimes(1);
  expect((await readBackup(session)).message).toContain('等待打开应用');
});

test('a large video waits for the user-started visible transfer instead of consuming a background window', async () => {
  const video = {id: '7', uri: 'content://media/external/video/media/7', fingerprint: 'video:external:v1:7:50:100',
    name: 'large.mp4', mime: 'video/mp4', size: 129 * 1024 * 1024};
  native.scan.mockImplementation(async (cursor: string, kind: string) => kind === 'video' && cursor === '0'
    ? {items: [video], next: '7'} : {items: [], next: cursor});
  await configureBackup(session, {...enabled, enabled: false, videoEnabled: true});
  await runBackup(session, api);
  expect(native.stage).not.toHaveBeenCalled();
  expect((await readBackup(session)).pendingForegroundVideo).toBe(video.fingerprint);
  await runVisibleBackup(session, api);
  expect(uploadOne).toHaveBeenCalledTimes(1);
  expect((await readBackup(session)).completed[video.fingerprint]).toBe(true);
  expect((await readBackup(session)).pendingForegroundVideo).toBeUndefined();
});

test('a deleted destination is checked before staging and waits for user retry', async () => {
  (api.request as jest.Mock).mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'folder missing'));
  await runBackup(session, api);
  expect(native.stage).not.toHaveBeenCalled();
  expect((await readBackup(session)).targetBlocked).toContain('已删除');
  await runBackup(session, api);
  expect(api.request).toHaveBeenCalledTimes(1);
  await retryBlockedBackup(session);
  await runBackup(session, api);
  expect(uploadOne).toHaveBeenCalledTimes(1);
});

test('a read-only destination pauses backup before copying a video', async () => {
  const video = {id: '7', uri: 'content://media/external/video/media/7', fingerprint: 'video:external:v1:7:50:100',
    name: 'clip.mp4', mime: 'video/mp4', size: 50};
  native.scan.mockImplementation(async (cursor: string, kind: string) => kind === 'video' && cursor === '0'
    ? {items: [video], next: '7'} : {items: [], next: cursor});
  await configureBackup(session, {...enabled, enabled: false, videoEnabled: true});
  (api.request as jest.Mock).mockResolvedValue({...folder, effective_permission: 'read'});
  await runBackup(session, api);
  expect(native.stage).not.toHaveBeenCalled();
  expect((await readBackup(session)).targetBlocked).toContain('无写入权限');
});

test('revoked video permission prevents starting the visible service', async () => {
  await configureBackup(session, {...enabled, enabled: false, videoEnabled: true});
  (PermissionsAndroid.check as jest.Mock).mockResolvedValue(false);
  (PermissionsAndroid.request as jest.Mock).mockResolvedValue('denied');
  await expect(runVisibleBackup(session, api)).rejects.toThrow('允许访问全部视频');
  expect(native.startVisible).not.toHaveBeenCalled();
});

test('Android 13 requires a visible notification before starting a long transfer', async () => {
  await configureBackup(session, {...enabled, enabled: false, videoEnabled: true});
  (Platform as {Version: number}).Version = 33;
  (PermissionsAndroid.check as jest.Mock).mockImplementation(async (permission: string) => permission !== 'notifications');
  (PermissionsAndroid.request as jest.Mock).mockResolvedValue('denied');
  await expect(runVisibleBackup(session, api)).rejects.toThrow('备份通知');
  expect(native.startVisible).not.toHaveBeenCalled();
});
