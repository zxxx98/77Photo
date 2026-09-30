import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {TextInput} from 'react-native';
import {BrowseApi, type Folder, type Photo} from '../src/browse/api';
import {CreateFolder, FolderPicker} from '../src/browse/ManagementUI';
import {PhotoActions} from '../src/browse/PhotoActions';
import PhotoFilters, {emptyFilters} from '../src/browse/PhotoFilters';
import TrashPage from '../src/browse/TrashPage';

jest.useRealTimers();
jest.mock('../src/auth/session', () => ({saveSession: jest.fn(), clearSession: jest.fn()}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const folder: Folder = {id: 'f', owner_id: 'me', parent_id: null, name: '家庭', is_shared: false, effective_permission: 'write'};
const photo = (id: string): Photo => ({id, owner_id: 'me', folder_id: 'f', filename: `${id}.jpg`, mime_type: 'image/jpeg', captured_at: '2026-09-30T12:00:00Z', size: 10});
let renderer: ReactTestRenderer;
async function render(element: React.ReactElement) {await act(async () => {renderer = create(element);});}
function button(label: string) {return renderer.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0]!;}
async function press(label: string) {await act(async () => {button(label).props.onPress();});}
afterEach(async () => {if (renderer) {await act(async () => renderer.unmount());}});
function fakeApi(input: Record<string, unknown> = {}) {
  return {subscribe: () => () => {}, getRevision: () => 0, listFolders: jest.fn().mockResolvedValue([folder]), writableFolder: jest.fn().mockResolvedValue(folder), ...input} as unknown as BrowseApi;
}

test('invalid calendar dates cannot apply; filename and media filters can apply together', async () => {
  const apply = jest.fn(); const close = jest.fn();
  await render(<PhotoFilters api={fakeApi()} value={emptyFilters} apply={apply} close={close} />);
  async function input(label: string, value: string) {await act(async () => {renderer.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === label)!.props.onChangeText(value);});}
  await input('开始日期', '2026-02-29'); await press('应用筛选');
  expect(apply).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  await input('开始日期', '2026-09-01'); await input('结束日期', '2026-09-30'); await input('搜索文件名', ' 家庭 ');
  await press('视频'); await press('应用筛选');
  expect(apply).toHaveBeenCalledWith({q: '家庭', mediaType: 'video', fromDate: '2026-09-01', toDate: '2026-09-30'}); expect(close).toHaveBeenCalledTimes(1);
});

test('read-only folders are browsable but cannot be selected as write destinations', async () => {
  const choose = jest.fn(); const api = fakeApi({listFolders: jest.fn().mockResolvedValue([{...folder, effective_permission: 'read'}])});
  await render(<FolderPicker api={api} choose={choose} close={jest.fn()} ownerId="me" />);
  await press('家庭 · 只读 ›'); expect(button('选择此目录').props.disabled).toBe(true); expect(choose).not.toHaveBeenCalled();
});

test('new folder errors keep the form open and creation uses the current directory', async () => {
  const api = fakeApi({createFolder: jest.fn().mockRejectedValueOnce(new Error('重名')).mockResolvedValue(folder)});
  const close = jest.fn(); const created = jest.fn();
  await render(<CreateFolder api={api} parent={folder} close={close} created={created} />);
  await act(async () => {renderer.root.findByType(TextInput).props.onChangeText('  假期  ');});
  await press('创建文件夹'); expect(close).not.toHaveBeenCalled();
  await press('创建文件夹'); expect(api.createFolder).toHaveBeenLastCalledWith('假期', 'f'); expect(created).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
});

test('partial deletion removes only successes and retains failed selection', async () => {
  const api = fakeApi({deletePhotos: jest.fn().mockResolvedValue({deleted_ids: ['a'], failed: [{id: 'b', code: 'WRITE_FORBIDDEN'}]})});
  const completed = jest.fn(); const retain = jest.fn(); const close = jest.fn();
  await render(<PhotoActions api={api} photos={[photo('a'), photo('b')]} completed={completed} retain={retain} close={close} />);
  await press('删除'); expect(api.deletePhotos).not.toHaveBeenCalled(); await press('确认移入回收站');
  expect(completed).toHaveBeenCalledWith(['a']); expect(retain).toHaveBeenCalledWith(['b']); expect(close).not.toHaveBeenCalled();
});

test('read-only photos do not offer enabled move or delete actions', async () => {
  const api = fakeApi({writableFolder: jest.fn().mockResolvedValue({...folder, effective_permission: 'read'})});
  await render(<PhotoActions api={api} photos={[photo('a')]} completed={jest.fn()} close={jest.fn()} />);
  expect(button('移动').props.disabled).toBe(true); expect(button('删除').props.disabled).toBe(true);
});

test('trash restoration chooses a target and purge requires confirmation', async () => {
  const item = {id: 'a', owner_id: 'me', filename: 'a.jpg', mime_type: 'image/jpeg', size: 10, folder_id: 'old', folder_name: '旧目录', deleted_at: '2026-09-30T12:00:00Z', expires_at: '2026-10-30T12:00:00Z', state: 'trashed', recovery_required: false};
  const api = fakeApi({listTrash: jest.fn().mockResolvedValue({items: [item], next_cursor: null, retention_days: 30}), trashPreview: jest.fn().mockResolvedValue({uri: 'https://example.test/preview', headers: {Authorization: 'Bearer token'}}),
    restoreTrash: jest.fn().mockResolvedValue({completed_ids: [], failed: [{id: 'a', code: 'NAME_CONFLICT'}]}), purgeTrash: jest.fn().mockResolvedValue({completed_ids: ['a'], failed: []})});
  await render(<TrashPage api={api} close={jest.fn()} />);
  await press('选择 a.jpg'); await press('恢复'); await press('选择其他目标目录'); await press('家庭 ›'); await press('选择此目录'); await press('同名时自动改名：关'); await press('确认恢复');
  expect(api.restoreTrash).toHaveBeenCalledWith(['a'], 'f', true); expect(button('取消选择 a.jpg').props.accessibilityState.selected).toBe(true);
  await press('永久删除'); expect(api.purgeTrash).not.toHaveBeenCalled(); await press('确认永久删除'); expect(api.purgeTrash).toHaveBeenCalledWith(['a']);
  expect(renderer.root.findAll(node => node.props.accessibilityLabel === '选择 a.jpg').length > 0).toBe(false);
});
