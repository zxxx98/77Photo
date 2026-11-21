import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {Text} from 'react-native';
import App from '../App';
import {restoreSession} from '../src/auth/controller';
import {loadSession, type MobileSession} from '../src/auth/session';

jest.useRealTimers();
jest.mock('react-native-safe-area-context', () => ({SafeAreaProvider: ({children}: {children: React.ReactNode}) => children, useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})}));
jest.mock('../src/auth/session', () => ({loadSession: jest.fn(), loadLastServer: jest.fn().mockResolvedValue(''), loadLastProfile: jest.fn(), saveSession: jest.fn(), clearSession: jest.fn()}));
jest.mock('../src/auth/controller', () => ({restoreSession: jest.fn()}));
jest.mock('../src/backup/service', () => ({enterBackupUI: jest.fn().mockResolvedValue(undefined), leaveBackupUI: jest.fn(), disableBackup: jest.fn()}));
jest.mock('../src/upload/queue', () => ({clearQueue: jest.fn()}));
let library: {session: MobileSession; onExpired: () => Promise<void>} | undefined;
jest.mock('../src/browse/BrowseApp', () => (props: {session: MobileSession; onExpired: () => Promise<void>}) => {library = props; return null;});
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const saved: MobileSession = {server: 'https://photos.test', username: 'alice', userId: 'u1', accessToken: 'a', accessExpiresAt: '2020-01-01T00:00:00Z', refreshToken: 'r', refreshExpiresAt: ''};
let renderer: ReactTestRenderer;
const text = () => renderer.root.findAllByType(Text).map(node => [node.props.children].flat().join('')).join(' ');
async function start() {library = undefined; await act(async () => {renderer = create(<App />);});}
afterEach(async () => {await act(async () => renderer.unmount()); jest.clearAllMocks();});

test('a stored session opens the library without waiting for the server', async () => {
  (loadSession as jest.Mock).mockResolvedValue(saved);
  // The network never answers; the library is on screen regardless.
  (restoreSession as jest.Mock).mockReturnValue(new Promise(() => {}));
  await start();
  expect(library?.session).toBe(saved); expect(restoreSession).not.toHaveBeenCalled();
});

test('a session stored before account IDs existed is still validated first', async () => {
  const legacy = {...saved, userId: undefined};
  (loadSession as jest.Mock).mockResolvedValue(legacy);
  (restoreSession as jest.Mock).mockResolvedValue(saved);
  await start();
  expect(restoreSession).toHaveBeenCalledWith(legacy); expect(library?.session).toBe(saved);
});

test('a rejected device returns to login only once its credentials are gone', async () => {
  (loadSession as jest.Mock).mockResolvedValue(saved);
  await start();
  await act(async () => {await library!.onExpired();});
  expect(text()).not.toContain('连接服务器');
  (loadSession as jest.Mock).mockRejectedValue(new Error('keystore busy'));
  await act(async () => {await library!.onExpired();});
  expect(text()).not.toContain('连接服务器');
  (loadSession as jest.Mock).mockResolvedValue(null);
  await act(async () => {await library!.onExpired();});
  expect(text()).toContain('连接服务器'); expect(text()).toContain('登录已失效，请重新登录');
});
