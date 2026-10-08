import React from 'react';
import {Linking} from 'react-native';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import UpdateSettings from '../src/update/UpdateSettings';
import {checkForUpdate} from '../src/update/releases';

jest.mock('../src/update/releases', () => ({currentVersion: '0.4.10', checkForUpdate: jest.fn()}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer;
const check = checkForUpdate as jest.Mock;
const button = (label: string) => renderer.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];
beforeEach(async () => {await act(async () => {renderer = create(<UpdateSettings />);});});
afterEach(async () => {await act(async () => renderer.unmount()); jest.resetAllMocks(); jest.restoreAllMocks();});

test('checks only on demand, prevents duplicate checks and reports latest', async () => {
  expect(check).not.toHaveBeenCalled();
  let finish!: (value: null) => void;
  check.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
  await act(async () => {button('检查更新').props.onPress();});
  expect(button('正在检查更新…').props.disabled).toBe(true);
  await act(async () => {button('正在检查更新…').props.onPress();});
  expect(check).toHaveBeenCalledTimes(1);
  await act(async () => {finish(null);});
  expect(JSON.stringify(renderer.toJSON())).toContain('当前已是最新版本');
});

test('allows retry after a failed check and opens the offered download', async () => {
  check.mockRejectedValueOnce(new Error('网络失败'));
  await act(async () => {await button('检查更新').props.onPress();});
  expect(JSON.stringify(renderer.toJSON())).toContain('网络失败');
  check.mockResolvedValue({version: '0.5.0', notes: '修复问题', downloadUrl: 'https://github.com/test.apk', pageUrl: 'https://github.com/release'});
  await act(async () => {await button('检查更新').props.onPress();});
  expect(JSON.stringify(renderer.toJSON())).toContain('发现新版本 0.5.0');
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  await act(async () => {await button('下载新版本').props.onPress();});
  expect(open).toHaveBeenCalledWith('https://github.com/test.apk');
  open.mockRejectedValue(new Error('no browser'));
  await act(async () => {await button('查看发布页面').props.onPress();});
  expect(JSON.stringify(renderer.toJSON())).toContain('无法打开浏览器');
});

test('cancels pending checks when leaving settings', async () => {
  check.mockImplementation(() => new Promise(() => {}));
  await act(async () => {button('检查更新').props.onPress();});
  const signal = check.mock.calls[0][0] as AbortSignal;
  await act(async () => renderer.unmount());
  expect(signal.aborted).toBe(true);
});
