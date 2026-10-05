import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import type {BrowseApi, Folder} from '../src/browse/api';
import BackupSettings from '../src/backup/BackupSettings';
import {configureBackup, readBackup, type BackupSettings as Settings} from '../src/backup/service';

jest.useRealTimers();
jest.mock('@react-native-community/netinfo', () => ({addEventListener: jest.fn(() => jest.fn())}));
jest.mock('../src/backup/service', () => ({
  bindBackup: jest.fn(() => jest.fn()), subscribeBackup: jest.fn(() => jest.fn()),
  readBackup: jest.fn(), restoreBackupSchedule: jest.fn().mockResolvedValue(undefined),
  runBackup: jest.fn().mockResolvedValue(undefined), configureBackup: jest.fn().mockResolvedValue(undefined),
  requestMediaAccess: jest.fn().mockResolvedValue(undefined), isVisibleBackupRunning: jest.fn(() => false),
}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const session = {server: 'http://192.168.1.2', username: 'alice', accessToken: 'a', accessExpiresAt: '', refreshToken: 'r', refreshExpiresAt: ''};
const folder: Folder = {id: 'root', name: '手机备份', owner_id: 'u1', parent_id: null, is_shared: false};
const settings = {enabled: false, videoEnabled: false, wifiOnly: true, folder: null, dateFolders: true};
let renderer: ReactTestRenderer;
const toggle = (label: string) => renderer.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onValueChange === 'function')[0];
async function render(saved: Settings = settings) {
  (readBackup as jest.Mock).mockResolvedValue({settings: saved, completed: {}});
  await act(async () => {renderer = create(<BackupSettings session={session} api={{} as BrowseApi} folder={folder} />);});
}
afterEach(async () => {await act(async () => {renderer?.unmount();}); jest.clearAllMocks();});

test('enabling backup saves the chosen root and date archive setting', async () => {
  await render();
  expect(toggle('按年月日归档').props.value).toBe(true);
  await act(async () => {await toggle('自动备份照片').props.onValueChange(true);});
  expect(configureBackup).toHaveBeenCalledWith(session, {...settings, enabled: true, folder});
  expect(toggle('按年月日归档').props.disabled).toBe(true);
});

test('layout can change while disabled and remains locked while video backup runs', async () => {
  await render();
  await act(async () => {await toggle('按年月日归档').props.onValueChange(false);});
  expect(configureBackup).toHaveBeenCalledWith(session, {...settings, dateFolders: false});
  expect(toggle('按年月日归档').props.value).toBe(false);
  await act(async () => {await toggle('备份视频').props.onValueChange(true);});
  expect(toggle('按年月日归档').props.disabled).toBe(true);
});

test('enabling photos while video backup runs preserves its root despite a different upload selection', async () => {
  const existingRoot = {...folder, id: 'existing', name: '原有备份'};
  await render({...settings, folder: existingRoot, videoEnabled: true});
  await act(async () => {await toggle('自动备份照片').props.onValueChange(true);});
  expect(configureBackup).toHaveBeenCalledWith(session, {...settings, folder: existingRoot, videoEnabled: true, enabled: true});
});
