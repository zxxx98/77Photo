import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import ReactNativeBlobUtil from 'react-native-blob-util';
import type {BrowseApi} from '../src/browse/api';
import UploadPage from '../src/upload/UploadPage';
import {deleteStagedFiles, loadQueue, saveQueue, uploadOne, type UploadItem} from '../src/upload/queue';

jest.useRealTimers();
jest.mock('react-native-blob-util', () => ({__esModule: true, default: {fs: {exists: jest.fn().mockResolvedValue(true)}}}));
jest.mock('../src/backup/BackupSettings', () => () => null);
jest.mock('../src/upload/queue', () => ({allowQueue: jest.fn(), loadQueue: jest.fn(), saveQueue: jest.fn().mockResolvedValue(undefined), deleteStagedFiles: jest.fn().mockResolvedValue(undefined),
  isCompleted: (item: UploadItem) => item.status === 'success' || item.status === 'skipped', uploadOne: jest.fn(), uploadError: () => '上传失败', pairMedia: jest.fn(), pickMedia: jest.fn()}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const session = {server: 'http://192.168.1.2', username: 'alice', accessToken: 'a', accessExpiresAt: '', refreshToken: 'r', refreshExpiresAt: ''};
const item = (id: string): UploadItem => ({id, path: `/${id}`, name: `${id}.jpg`, mime: 'image/jpeg', size: 100, folderId: 'f', folderName: '家庭', status: 'waiting', progress: 0});
let renderer: ReactTestRenderer;
function button(label: string) {return renderer.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];}
async function press(label: string) {await act(async () => {button(label).props.onPress();});}
afterEach(async () => {await act(async () => {renderer?.unmount();}); jest.clearAllMocks();});

async function render() {await act(async () => {renderer = create(<UploadPage api={{} as BrowseApi} session={session} active incomingFolder={null} clearIncoming={jest.fn()} />);});}

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
