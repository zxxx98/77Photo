import {ApiError} from '../src/auth/api';
import type {BrowseApi, Folder} from '../src/browse/api';
import {backupDateParts, dateDestination} from '../src/backup/destination';

const root: Folder = {id: 'root', name: '备份', owner_id: 'u1', parent_id: null, is_shared: false};
const child = (parent: Folder, name: string): Folder => ({...root, id: `${parent.id}/${name}`, parent_id: parent.id, name});
const capturedAt = new Date(2026, 9, 5, 0, 15).getTime();

test('uses the local capture date, then added date, modified date and an unknown folder', () => {
  const addedAt = new Date(2025, 0, 2, 23, 45).getTime();
  expect(backupDateParts({capturedAt, addedAt})).toEqual(['2026', '10', '05']);
  expect(backupDateParts({capturedAt: 0, addedAt, modifiedAt: capturedAt})).toEqual(['2025', '01', '02']);
  expect(backupDateParts({capturedAt: NaN, addedAt: -1, modifiedAt: capturedAt})).toEqual(['2026', '10', '05']);
  expect(backupDateParts({capturedAt: Infinity, addedAt: 9e20})).toEqual(['日期未知']);
  expect(backupDateParts({})).toEqual(['日期未知']);
  expect(backupDateParts({capturedAt: new Date(2024, 1, 29).getTime()})).toEqual(['2024', '02', '29']);
});

test('creates year/month/day under the selected root and reuses folders across photos', async () => {
  const request = jest.fn().mockResolvedValue({items: []});
  const createFolder = jest.fn(async (name: string, parentId: string) => child({...root, id: parentId}, name));
  const api = {request, createFolder} as unknown as BrowseApi;
  const resolve = dateDestination(api, root, new AbortController().signal);
  expect((await resolve({capturedAt})).id).toBe('root/2026/10/05');
  await resolve({capturedAt});
  await resolve({capturedAt: new Date(2026, 9, 6).getTime()});
  expect(createFolder.mock.calls).toEqual([['2026', 'root'], ['10', 'root/2026'], ['05', 'root/2026/10'], ['06', 'root/2026/10']]);
  expect(request).toHaveBeenCalledTimes(3);
});

test('existing directories are reused only within the root owner and parent', async () => {
  const year = child(root, '2026');
  const month = child(year, '10');
  const day = child(month, '05');
  const request = jest.fn(async (path: string) => ({items: [
    {...year, owner_id: 'someone-else'}, {...year, parent_id: 'elsewhere'},
    ...[year, month, day].filter(folder => folder.parent_id === new URL(`http://server${path}`).searchParams.get('parent_id'))]}));
  const createFolder = jest.fn();
  const resolve = dateDestination({request, createFolder} as unknown as BrowseApi, root, new AbortController().signal);
  expect(await resolve({capturedAt})).toEqual(day);
  expect(createFolder).not.toHaveBeenCalled();
});

test('a concurrent creation conflict is reconciled by listing the existing folder', async () => {
  const unknown = child(root, '日期未知');
  const request = jest.fn().mockResolvedValueOnce({items: []}).mockResolvedValueOnce({items: [unknown]});
  const createFolder = jest.fn().mockRejectedValue(new ApiError(409, 'NAME_CONFLICT', 'exists'));
  const resolve = dateDestination({request, createFolder} as unknown as BrowseApi, root, new AbortController().signal);
  expect(await resolve({})).toEqual(unknown);
  expect(createFolder).toHaveBeenCalledTimes(1);
});

test('a lost create response is not replayed; the next scan reuses the created directory', async () => {
  const unknown = child(root, '日期未知');
  const request = jest.fn().mockResolvedValueOnce({items: []}).mockResolvedValueOnce({items: [unknown]});
  const createFolder = jest.fn().mockRejectedValue(new TypeError('connection lost'));
  const api = {request, createFolder} as unknown as BrowseApi;
  await expect(dateDestination(api, root, new AbortController().signal)({})).rejects.toThrow('connection lost');
  expect(await dateDestination(api, root, new AbortController().signal)({})).toEqual(unknown);
  expect(createFolder).toHaveBeenCalledTimes(1);
});

test('an unrelated name conflict and a read-only directory never select another destination', async () => {
  const request = jest.fn().mockResolvedValue({items: []});
  const conflict = new ApiError(409, 'NAME_CONFLICT', 'file exists');
  const createFolder = jest.fn().mockRejectedValue(conflict);
  const api = {request, createFolder} as unknown as BrowseApi;
  await expect(dateDestination(api, root, new AbortController().signal)({})).rejects.toBe(conflict);
  request.mockResolvedValue({items: [{...child(root, '日期未知'), effective_permission: 'read'}]});
  await expect(dateDestination(api, root, new AbortController().signal)({})).rejects.toMatchObject({status: 403});
});

test('disabling backup during a listing prevents directory creation', async () => {
  const controller = new AbortController();
  const request = jest.fn(async () => {controller.abort(); return {items: []};});
  const createFolder = jest.fn();
  const resolve = dateDestination({request, createFolder} as unknown as BrowseApi, root, controller.signal);
  await expect(resolve({capturedAt})).rejects.toThrow('已暂停');
  expect(createFolder).not.toHaveBeenCalled();
});
