import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import ReactNativeBlobUtil from 'react-native-blob-util';
import {ScrollView} from 'react-native';
import type {BrowseApi, Folder} from '../src/browse/api';
import BackupSettings from '../src/backup/BackupSettings';
import UploadPage from '../src/upload/UploadPage';
import {deleteStagedFiles, loadQueue, pairMedia, pickMedia, prepareUpload, saveQueue, uploadOne, type UploadItem} from '../src/upload/queue';

jest.useRealTimers();
jest.mock('@react-native-async-storage/async-storage', () => ({getItem: jest.fn(), setItem: jest.fn()}));
jest.mock('react-native-blob-util', () => ({__esModule: true, default: {fs: {exists: jest.fn().mockResolvedValue(true)}}}));
jest.mock('../src/backup/BackupSettings', () => () => null);
jest.mock('../src/upload/queue', () => ({allowQueue: jest.fn(), loadQueue: jest.fn(), saveQueue: jest.fn().mockResolvedValue(undefined), deleteStagedFiles: jest.fn().mockResolvedValue(undefined),
  isCompleted: (item: UploadItem) => item.status === 'success' || item.status === 'skipped', uploadOne: jest.fn(), uploadError: () => '上传失败',
  pairMedia: jest.fn((...args) => jest.requireActual('../src/upload/queue').pairMedia(...args)), pickMedia: jest.fn(),
  prepareUpload: jest.fn(async (_api, entry) => entry)}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const session = {server: 'http://192.168.1.2', username: 'alice', accessToken: 'a', accessExpiresAt: '', refreshToken: 'r', refreshExpiresAt: ''};
const item = (id: string): UploadItem => ({id, path: `/${id}`, name: `${id}.jpg`, mime: 'image/jpeg', size: 100, folderId: 'f', folderName: '家庭', status: 'waiting', progress: 0});
let renderer: ReactTestRenderer;
function button(label: string) {return renderer.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];}
async function press(label: string) {await act(async () => {button(label).props.onPress();});}
afterEach(async () => {await act(async () => {renderer?.unmount();}); jest.clearAllMocks();});

async function render(folder: Folder | null = null) {await act(async () => {renderer = create(<UploadPage api={{} as BrowseApi} session={session} active incomingFolder={folder} clearIncoming={jest.fn()} />);});}

test('cancel aborts active transfer, ignores late progress and success, then permits retry', async () => {
  let finish!: (value: 'success') => void; let progress!: (value: number) => void; let signal!: AbortSignal;
  (loadQueue as jest.Mock).mockResolvedValue([item('a')]);
  (uploadOne as jest.Mock).mockImplementationOnce((_api, _item, update, abort) => {progress = update; signal = abort; return new Promise(resolve => {finish = resolve;});}).mockResolvedValue('success');
  await render(); await press('取消上传 a.jpg'); expect(signal.aborted).toBe(true); expect(button('重试上传 a.jpg').props.disabled).toBe(true);
  await act(async () => {progress(77); finish('success');});
  const saved = (saveQueue as jest.Mock).mock.calls.at(-1)[1]; expect(saved[0]).toMatchObject({status: 'cancelled', progress: 0});
  expect(button('重试上传 a.jpg').props.disabled).toBe(false); expect(deleteStagedFiles).not.toHaveBeenCalled();
  await press('重试上传 a.jpg'); expect(uploadOne).toHaveBeenCalledTimes(2); expect((saveQueue as jest.Mock).mock.calls.at(-1)[1][0].status).toBe('success');
});

test('cancel before staging check completes prevents transfer; remove cleans only after settlement', async () => {
  let exists!: (value: boolean) => void;
  (ReactNativeBlobUtil.fs.exists as jest.Mock).mockImplementationOnce(() => new Promise(resolve => {exists = resolve;}));
  (loadQueue as jest.Mock).mockResolvedValue([item('a')]);
  await render(); await press('取消上传 a.jpg');
  expect(button('移除已取消的 a.jpg').props.disabled).toBe(true);
  await act(async () => {exists(true);}); expect(uploadOne).not.toHaveBeenCalled();
  await press('移除已取消的 a.jpg'); expect((saveQueue as jest.Mock).mock.calls.at(-1)[1]).toEqual([]); expect(deleteStagedFiles).toHaveBeenCalledWith([expect.objectContaining({status: 'cancelled', path: '/a'})]);
});

test('cancelling a waiting item keeps it out of the next upload while other work finishes', async () => {
  let finish!: (value: 'success') => void;
  (loadQueue as jest.Mock).mockResolvedValue([item('a'), item('b')]);
  (uploadOne as jest.Mock).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  await render(); await press('取消上传 b.jpg'); await act(async () => {finish('success');});
  expect(uploadOne).toHaveBeenCalledTimes(1); expect((saveQueue as jest.Mock).mock.calls.at(-1)[1].find((entry: UploadItem) => entry.id === 'b').status).toBe('cancelled');
});


test('unmount aborts the active upload and never starts the next waiting item', async () => {
  let finish!: (value: 'success') => void; let signal!: AbortSignal;
  (loadQueue as jest.Mock).mockResolvedValue([item('a'), item('b')]);
  (uploadOne as jest.Mock).mockImplementationOnce((_api, _item, _update, abort) => {signal = abort; return new Promise(resolve => {finish = resolve;});});
  await render(); await act(async () => {renderer.unmount();});
  expect(signal.aborted).toBe(true);
  await act(async () => {finish('success');});
  expect(uploadOne).toHaveBeenCalledTimes(1);
});

test('manual controls and queue share a scrollable page; backup settings stay mounted when switching tabs', async () => {
  (loadQueue as jest.Mock).mockResolvedValue([{...item('a'), status: 'failed'}]);
  await render();
  const scroll = renderer.root.findAllByType(ScrollView).find(node => node.props.testID === 'manual-upload-content')!;
  expect(scroll.findAllByType(ScrollView)).toHaveLength(1);
  expect(scroll.findAll(node => node.props.accessibilityLabel === '重试上传 a.jpg').length).toBeGreaterThan(0);
  expect(scroll.findAll(node => node.props.accessibilityLabel === '选择照片与视频并加入手选上传队列').length).toBeGreaterThan(0);
  const backup = renderer.root.findByType(BackupSettings);
  await press('自动备份设置');
  expect(renderer.root.findAllByProps({testID: 'manual-upload-content'})).toHaveLength(0);
  expect(renderer.root.findByType(BackupSettings)).toBe(backup);
  await press('手动上传');
  expect(button('重试上传 a.jpg')).toBeDefined();
  expect(renderer.root.findByType(BackupSettings)).toBe(backup);
});

test('each selection snapshots the manual archive choice and its root', async () => {
  const root: Folder = {id: 'root', owner_id: 'u1', parent_id: null, name: '相册', is_shared: false};
  (loadQueue as jest.Mock).mockResolvedValue([]);
  (pickMedia as jest.Mock).mockResolvedValue([{path: '/picked', name: 'picked.jpg', mime: 'image/jpeg', size: 10, capturedAt: new Date(2026, 9, 5).getTime()}]);
  (uploadOne as jest.Mock).mockResolvedValue('success');
  await render(root);
  await press('选择照片与视频并加入手选上传队列');
  expect(pairMedia).toHaveBeenLastCalledWith(expect.any(Array), root, true);
  const toggle = renderer.root.findAll(node => node.props.accessibilityLabel === '手动上传按年月日归档' && typeof node.props.onValueChange === 'function')[0];
  await act(async () => {toggle.props.onValueChange(false);});
  await press('选择照片与视频并加入手选上传队列');
  expect(pairMedia).toHaveBeenLastCalledWith(expect.any(Array), root, false);
  const saved = (saveQueue as jest.Mock).mock.calls.at(-1)[1];
  expect(saved[0].dateArchive).toMatchObject({rootId: 'root', parts: ['2026', '10', '05']});
  expect(saved[1].dateArchive).toBeUndefined();
});

test('date folder resolution is persisted before bytes upload and cancellation during resolution prevents transfer', async () => {
  const dated = {...item('dated'), dateArchive: {rootId: 'f', parts: ['2026', '10', '05']}};
  (loadQueue as jest.Mock).mockResolvedValue([dated]);
  (prepareUpload as jest.Mock).mockImplementationOnce(async (_api, entry) => ({...entry, folderId: 'day', dateArchive: {...entry.dateArchive, resolved: true}}));
  (uploadOne as jest.Mock).mockImplementationOnce(async (_api, entry) => {
    expect(entry.folderId).toBe('day');
    expect((saveQueue as jest.Mock).mock.calls.at(-1)[1][0]).toMatchObject({folderId: 'day', dateArchive: {resolved: true}});
    return 'success';
  });
  await render();
  expect(uploadOne).toHaveBeenCalledTimes(1);
  await act(async () => {renderer.unmount();});
  jest.clearAllMocks();
  (loadQueue as jest.Mock).mockResolvedValue([dated]);
  let finish!: (entry: UploadItem) => void;
  (prepareUpload as jest.Mock).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  await render();
  await press('取消上传 dated.jpg');
  await act(async () => {finish({...dated, folderId: 'day'});});
  expect(uploadOne).not.toHaveBeenCalled();
  expect((saveQueue as jest.Mock).mock.calls.at(-1)[1][0]).toMatchObject({status: 'cancelled', folderId: 'f'});
});

test('byte transfer waits for the resolved directory write to finish', async () => {
  const dated = {...item('dated'), dateArchive: {rootId: 'f', parts: ['2026', '10', '05']}};
  (loadQueue as jest.Mock).mockResolvedValue([dated]);
  (prepareUpload as jest.Mock).mockResolvedValueOnce({...dated, folderId: 'day', dateArchive: {...dated.dateArchive, resolved: true}});
  let finish!: () => void;
  const persisted = new Promise<void>(resolve => {finish = resolve;});
  (saveQueue as jest.Mock).mockImplementation(async (_session, entries: UploadItem[]) => {
    if (entries[0]?.folderId === 'day' && entries[0]?.status === 'uploading') {await persisted;}
  });
  (uploadOne as jest.Mock).mockResolvedValue('success');
  try {
    await render();
    expect((saveQueue as jest.Mock).mock.calls.at(-1)[1][0].folderId).toBe('day');
    expect(uploadOne).not.toHaveBeenCalled();
    await act(async () => {finish();});
    expect(uploadOne).toHaveBeenCalledTimes(1);
  } finally {(saveQueue as jest.Mock).mockResolvedValue(undefined);}
});

test('a picker result arriving after an account change is cleaned up without entering either queue', async () => {
  const root: Folder = {id: 'root', owner_id: 'u1', parent_id: null, name: '相册', is_shared: false};
  (loadQueue as jest.Mock).mockResolvedValue([]);
  let finish!: (files: unknown[]) => void;
  (pickMedia as jest.Mock).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  await render(root);
  await press('选择照片与视频并加入手选上传队列');
  await act(async () => {renderer.update(<UploadPage api={{} as BrowseApi} session={{...session, username: 'bob'}} active incomingFolder={null} clearIncoming={jest.fn()} />);});
  await act(async () => {finish([{path: '/late', name: 'late.jpg', mime: 'image/jpeg', size: 10}]);});
  expect(deleteStagedFiles).toHaveBeenCalledWith([expect.objectContaining({path: '/late'})]);
  expect((saveQueue as jest.Mock).mock.calls.every(call => call[1].length === 0)).toBe(true);
  expect(uploadOne).not.toHaveBeenCalled();
});
