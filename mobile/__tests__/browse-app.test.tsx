import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {FlatList, Image} from 'react-native';
import {ApiError} from '../src/auth/api';
import {BrowseApi, type Folder, type Photo} from '../src/browse/api';
import BrowseApp from '../src/browse/BrowseApp';

jest.useRealTimers();
jest.mock('../src/auth/session', () => ({saveSession: jest.fn(), clearSession: jest.fn()}));
jest.mock('@react-native-community/netinfo', () => ({__esModule: true, default: {addEventListener: () => () => {}}}));
jest.mock('react-native-video', () => () => null);
jest.mock('react-native-blob-util', () => ({__esModule: true, default: {}}));
jest.mock('react-native-safe-area-context', () => {
  const {View} = require('react-native');
  return {SafeAreaView: View, useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})};
});
jest.mock('../src/upload/UploadPage', () => () => null);
jest.mock('../src/auth/ServerAddresses', () => () => null);
jest.mock('../src/update/UpdateSettings', () => () => null);
jest.mock('../src/map/MapPage', () => () => null);
jest.mock('../src/browse/PeoplePage', () => () => null);
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const session = {server: 'https://photos.test', username: 'alice', accessToken: 'token', accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(), refreshToken: 'r', refreshExpiresAt: ''};
const photo = (id: string): Photo => ({id, owner_id: 'me', folder_id: 'f', filename: `${id}.jpg`, mime_type: 'image/jpeg', captured_at: '2026-09-30T12:00:00Z', size: 10, is_favorite: false});
const folder: Folder = {id: 'f', owner_id: 'me', parent_id: null, name: '家庭', is_shared: false, effective_permission: 'write', photo_count: 4};
let renderer: ReactTestRenderer;
const pressable = (label: string) => renderer.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];
async function press(label: string) {await act(async () => {pressable(label).props.onPress();});}
const settle = () => act(async () => {await new Promise<void>(resolve => setTimeout(resolve, 0));});
const thumbnails = () => renderer.root.findAllByType(Image).map(image => image.props.source?.uri).filter((uri): uri is string => typeof uri === 'string' && uri.includes('/thumbnail'));

let listPhotos: jest.SpyInstance;
let hold = false;
beforeEach(() => {
  hold = false;
  listPhotos = jest.spyOn(BrowseApi.prototype, 'listPhotos').mockResolvedValue({items: [photo('a'), photo('b'), photo('c'), photo('d')], next_cursor: null, favorites_supported: true});
  jest.spyOn(BrowseApi.prototype, 'liveStatus').mockResolvedValue([]);
  jest.spyOn(BrowseApi.prototype, 'me').mockResolvedValue({id: 'me', role: 'user'});
  // The detail endpoint is held back, so the viewer shows what the list knows.
  jest.spyOn(BrowseApi.prototype, 'photo').mockImplementation(async id => hold ? new Promise<Photo>(() => {}) : photo(id));
  jest.spyOn(BrowseApi.prototype, 'writableFolder').mockResolvedValue(folder);
  jest.spyOn(BrowseApi.prototype, 'listFolders').mockImplementation(async parent => parent ? [] : [folder]);
  jest.spyOn(BrowseApi.prototype, 'setFavorite').mockResolvedValue(undefined);
  jest.spyOn(BrowseApi.prototype, 'deletePhotos').mockImplementation(async ids => ({deleted_ids: ids, failed: []}));
});
afterEach(async () => {await act(async () => renderer.unmount()); jest.restoreAllMocks();});
const onExpired = jest.fn();
async function render() {
  onExpired.mockClear();
  await act(async () => {renderer = create(<BrowseApp session={session} onSession={jest.fn()} onSignOut={jest.fn()} onExpired={onExpired} error="" />);});
  await settle();
}

test('thumbnails are requested on the first render of a tile', async () => {
  let rendered: string[] = [];
  listPhotos.mockResolvedValue({items: [photo('a')], next_cursor: null});
  const source = jest.spyOn(BrowseApi.prototype, 'mediaSource').mockImplementation(() => new Promise(() => {}));
  await render();
  rendered = thumbnails();
  // The authenticated source never resolved, yet the image is already loading.
  expect(source).toHaveBeenCalled();
  expect(rendered).toEqual(['https://photos.test/api/v1/photos/a/thumbnail?size=256']);
});

test('opening and closing a photo neither reloads nor clears the timeline', async () => {
  await render();
  expect(listPhotos).toHaveBeenCalledTimes(1);
  await press('照片，b.jpg'); await settle();
  expect(pressable('返回浏览')).toBeDefined();
  // The grid thumbnail stands in while the preview is fetched.
  expect(renderer.root.findAllByType(Image).some(image => image.props.source?.uri === 'https://photos.test/api/v1/photos/b/preview')).toBe(true);
  await press('加入收藏'); await settle();
  await press('返回浏览'); await settle();
  expect(pressable('返回浏览')).toBeUndefined();
  expect(listPhotos).toHaveBeenCalledTimes(1);
  expect(thumbnails()).toHaveLength(4);
  // The list itself now carries the favorite made in the viewer.
  hold = true;
  await press('照片，b.jpg'); await settle();
  expect(pressable('取消收藏')).toBeDefined();
});

test('cancelling a selection keeps the list; deleting removes the tile without a reload', async () => {
  await render();
  await act(async () => {pressable('照片，a.jpg').props.onLongPress();}); await settle();
  await press('取消选择'); await settle();
  expect(listPhotos).toHaveBeenCalledTimes(1); expect(thumbnails()).toHaveLength(4);
  await act(async () => {pressable('照片，a.jpg').props.onLongPress();}); await settle();
  await press('删除'); await press('确认移入回收站'); await settle();
  expect(BrowseApi.prototype.deletePhotos).toHaveBeenCalledWith(['a']);
  expect(pressable('照片，a.jpg')).toBeUndefined(); expect(thumbnails()).toHaveLength(3);
  expect(listPhotos).toHaveBeenCalledTimes(1);
});

test('a folder lists its media in virtualized rows of three', async () => {
  await render();
  await press('文件夹'); await settle();
  await press('进入文件夹 家庭'); await settle();
  const list = renderer.root.findAllByType(FlatList).find(node => Array.isArray(node.props.data) && Array.isArray(node.props.data[0]));
  expect(list?.props.data.map((row: Photo[]) => row.map(item => item.id))).toEqual([['a', 'b', 'c'], ['d']]);
  expect(listPhotos).toHaveBeenLastCalledWith('f', undefined, 50, false, expect.anything());
  expect(pressable('照片，d.jpg')).toBeDefined();
});

test('switching tabs keeps both pages mounted; folders load on first visit only', async () => {
  await render();
  expect(BrowseApi.prototype.listFolders).not.toHaveBeenCalled();
  const timeline = renderer.root.findAllByType(FlatList)[0].instance;
  await press('文件夹'); await settle();
  await press('进入文件夹 家庭'); await settle();
  const requests = listPhotos.mock.calls.length; const folderRequests = (BrowseApi.prototype.listFolders as jest.Mock).mock.calls.length;
  await press('照片'); await settle();
  // The same list instance is back, with nothing fetched again.
  expect(renderer.root.findAllByType(FlatList)[0].instance).toBe(timeline);
  await press('文件夹'); await settle();
  expect(pressable('返回上级文件夹')).toBeDefined();
  expect(listPhotos).toHaveBeenCalledTimes(requests); expect(BrowseApi.prototype.listFolders).toHaveBeenCalledTimes(folderRequests);
});

test('leaving a tab ends its selection', async () => {
  await render();
  await act(async () => {pressable('照片，a.jpg').props.onLongPress();}); await settle();
  expect(pressable('取消选择')).toBeDefined();
  await press('文件夹'); await settle();
  await press('照片'); await settle();
  expect(pressable('取消选择')).toBeUndefined();
});

test('reports a rejected device, but not a network failure', async () => {
  (BrowseApi.prototype.me as jest.Mock).mockRejectedValueOnce(new TypeError('offline'));
  await render();
  expect(onExpired).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
  (BrowseApi.prototype.me as jest.Mock).mockRejectedValueOnce(new ApiError(401, 'AUTH_REQUIRED', 'expired'));
  await render();
  expect(onExpired).toHaveBeenCalledTimes(1);
});
