import {ApiError, refresh} from '../src/auth/api';
import {saveSession, type MobileSession} from '../src/auth/session';
import {BrowseApi, errorState, groupPhotos} from '../src/browse/api';

jest.mock('../src/auth/api', () => ({
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(httpStatus: number, errorCode: string, errorMessage: string) {
      super(errorMessage);
      this.status = httpStatus;
      this.code = errorCode;
    }
  },
  refresh: jest.fn(),
}));
jest.mock('../src/auth/session', () => ({saveSession: jest.fn(), clearSession: jest.fn()}));

const session: MobileSession = {
  server: 'http://192.168.1.5:8080', username: 'lin', accessToken: 'old',
  accessExpiresAt: '2030-01-01T00:00:00Z', refreshToken: 'refresh', refreshExpiresAt: '2030-02-01T00:00:00Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  (saveSession as jest.Mock).mockResolvedValue(undefined);
});

test('parallel 401 responses share one token rotation and retry once', async () => {
  (refresh as jest.Mock).mockResolvedValue({...session, accessToken: 'new'});
  const seen: string[] = [];
  globalThis.fetch = jest.fn(async (_url, init) => {
    const token = (init as RequestInit).headers as {Authorization: string};
    seen.push(token.Authorization);
    return {ok: token.Authorization === 'Bearer new', status: token.Authorization === 'Bearer new' ? 200 : 401,
      json: async () => token.Authorization === 'Bearer new' ? {items: [], next_cursor: null} : {error: {code: 'AUTH_REQUIRED'}}} as Response;
  });
  const api = new BrowseApi(session, jest.fn());
  await Promise.all([api.listPhotos(), api.listPhotos()]);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(saveSession).toHaveBeenCalledTimes(1);
  expect(seen.filter(value => value === 'Bearer new')).toHaveLength(2);
});

test('favorite requests are idempotent methods and the list is scoped to the caller', async () => {
  const calls: {url: string; method: string; token: string}[] = [];
  globalThis.fetch = jest.fn(async (url, init) => {
    const options = init as RequestInit;
    const headers = options.headers as {Authorization: string};
    calls.push({url: String(url), method: options.method ?? 'GET', token: headers.Authorization});
    return {ok: true, status: 200, json: async () => ({items: [], next_cursor: null, favorites_supported: true})} as Response;
  });
  const api = new BrowseApi(session, jest.fn());
  await api.setFavorite('photo/1', true);
  await api.setFavorite('photo/1', false);
  await api.listPhotos(undefined, undefined, 50, true);
  expect(calls.map(call => [call.url.replace(session.server, ''), call.method, call.token])).toEqual([
    ['/api/v1/photos/photo%2F1/favorite', 'PUT', 'Bearer old'],
    ['/api/v1/photos/photo%2F1/favorite', 'DELETE', 'Bearer old'],
    ['/api/v1/photos?limit=50&favorite=true', 'GET', 'Bearer old'],
  ]);
});

test('uses captured_at date without client timezone conversion', () => {
  const base = {id: '1', owner_id: 'o', folder_id: 'f', filename: 'a', mime_type: 'image/jpeg', size: 1};
  const groups = groupPhotos([
    {...base, id: '1', captured_at: '2026-09-25T23:50:00-07:00'},
    {...base, id: '2', captured_at: '2026-09-26T00:01:00+09:00'},
  ]);
  expect(groups.map(group => group.date)).toEqual(['2026-09-26', '2026-09-25']);
});

test('lists shared roots and carries read permission into child folders', async () => {
  const folder = (id: string, owner_id: string, parent_id: string | null) =>
    ({id, owner_id, parent_id, name: id, is_shared: false});
  globalThis.fetch = jest.fn(async url => {
    const path = String(url).replace(session.server, '');
    const data = path === '/api/v1/folders' ? {items: [folder('mine', 'me', null)]} :
      path === '/api/v1/auth/me' ? {id: 'me', role: 'user'} :
      path === '/api/v1/shares' ? {items: [{resource_id: 'shared', user_id: 'me', permission: 'read'}]} :
      path === '/api/v1/folders/shared' ? folder('shared', 'other', null) :
      path === '/api/v1/folders/child' ? folder('child', 'other', 'shared') :
      path === '/api/v1/folders/mine' ? folder('mine', 'me', null) :
      path === '/api/v1/folders/mine-child' ? folder('mine-child', 'me', 'mine') :
      path === '/api/v1/folders?parent_id=mine' ? {items: [folder('mine-child', 'me', 'mine')]} :
      path === '/api/v1/folders?parent_id=mine-child' ? {items: [folder('mine-grandchild', 'me', 'mine-child')]} :
      path === '/api/v1/folders?parent_id=shared' ? {items: [folder('child', 'other', 'shared')]} :
      path === '/api/v1/folders?parent_id=child' ? {items: [folder('grandchild', 'other', 'child')]} : {};
    return {ok: true, status: 200, json: async () => data} as Response;
  });
  const api = new BrowseApi(session, jest.fn());
  const roots = await api.listFolders();
  expect(roots.map(item => [item.id, item.effective_permission])).toEqual([['mine', 'write'], ['shared', 'read']]);
  expect((await api.listFolders('shared'))[0].effective_permission).toBe('read');
  expect((await api.listFolders('child'))[0].effective_permission).toBe('read');
  expect((await api.listFolders('mine'))[0].effective_permission).toBe('write');
  expect((await api.listFolders('mine-child'))[0].effective_permission).toBe('write');
});

test('classifies authentication, permission and network failures separately', () => {
  expect(errorState(new ApiError(401, 'AUTH_REQUIRED', 'expired'))).toBe('expired');
  expect(errorState(new ApiError(403, 'FORBIDDEN', 'denied'))).toBe('forbidden');
  expect(errorState(new TypeError('Network request failed'))).toBe('offline');
});

test('verified failover sends authenticated reads to the selected address and preserves queue scope', async () => {
  const {ServerConnection} = require('../src/auth/connection');
  const vpn = 'http://100.90.1.5:8080';
  const profile = {id: session.server, publicKey: 'pinned', addresses: [
    {url: session.server, name: '家中', verified: true}, {url: vpn, name: '组网', verified: true},
  ]};
  const resolve = jest.spyOn(ServerConnection.prototype, 'resolve').mockResolvedValueOnce(session.server).mockResolvedValue(vpn);
  const urls: string[] = [];
  globalThis.fetch = jest.fn(async url => {
    urls.push(String(url));
    if (String(url).startsWith(session.server)) {throw new TypeError('network changed');}
    return {ok: true, status: 200, json: async () => ({items: [], next_cursor: null})} as Response;
  });
  const onSession = jest.fn();
  const api = new BrowseApi({...session, profile}, onSession);
  await expect(api.listPhotos()).resolves.toEqual({items: [], next_cursor: null});
  expect(urls).toEqual([`${session.server}/api/v1/photos?limit=50`, `${vpn}/api/v1/photos?limit=50`]);
  expect(onSession).toHaveBeenLastCalledWith(expect.objectContaining({server: vpn, profile}));
  expect((await api.mediaSource('photo', 'preview')).uri).toBe(`${vpn}/api/v1/photos/photo/preview`);
  resolve.mockRestore();
});

test('does not replay a refresh whose response was lost during a read retry', async () => {
  const {ServerConnection} = require('../src/auth/connection');
  const resolve = jest.spyOn(ServerConnection.prototype, 'resolve').mockResolvedValue(session.server);
  const profile = {id: session.server, publicKey: 'pinned', addresses: [{url: session.server, name: '家中', verified: true}]};
  globalThis.fetch = jest.fn(async () => ({ok: false, status: 401}) as Response);
  (refresh as jest.Mock).mockRejectedValue(new TypeError('refresh response lost'));
  const api = new BrowseApi({...session, profile}, jest.fn());
  const reconnect = jest.spyOn(api, 'reconnect');
  await expect(api.listPhotos()).rejects.toThrow('refresh response lost');
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(reconnect).not.toHaveBeenCalled();
  resolve.mockRestore();
});

test('search filters travel with the cursor and favorites in the same request', async () => {
  globalThis.fetch = jest.fn(async () => ({ok: true, status: 200, json: async () => ({items: [], next_cursor: null})}) as Response);
  const api = new BrowseApi(session, jest.fn());
  await api.listPhotos('folder/1', 'next', 50, true, {q: '家庭 & 旅行', mediaType: 'video', from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z'});
  const url = new URL(String((fetch as jest.Mock).mock.calls[0][0]));
  expect(Object.fromEntries(url.searchParams)).toEqual({limit: '50', folder_id: 'folder/1', cursor: 'next', favorite: 'true', q: '家庭 & 旅行', media_type: 'video', from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z'});
});

test('management uses bearer JSON writes and never separately deletes Live Photo motion', async () => {
  globalThis.fetch = jest.fn(async () => ({ok: true, status: 200, json: async () => ({})}) as Response);
  const api = new BrowseApi(session, jest.fn());
  await api.createFolder('家庭', null);
  await api.movePhoto('p/1', 'target', 'rename');
  await api.deletePhotos(['p/1']);
  await api.restoreTrash(['p/1'], 'target', true);
  await api.purgeTrash(['p/1']);
  await api.emptyTrash('2026-09-30T12:00:00Z');
  const calls = (fetch as jest.Mock).mock.calls.map(([url, init]) => [String(url).replace(session.server, ''), init.method, JSON.parse(init.body)]);
  expect(calls).toEqual([
    ['/api/v1/folders', 'POST', {name: '家庭', parent_id: null}],
    ['/api/v1/photos/p%2F1/move', 'POST', {target_folder_id: 'target', conflict: 'rename'}],
    ['/api/v1/photos/batch-delete', 'POST', {ids: ['p/1'], confirm: true}],
    ['/api/v1/trash/photos/batch-restore', 'POST', {ids: ['p/1'], folder_id: 'target', conflict: 'rename'}],
    ['/api/v1/trash/photos/batch-delete', 'POST', {ids: ['p/1'], confirm: true}],
    ['/api/v1/trash/photos/empty', 'POST', {scope: 'mine', before: '2026-09-30T12:00:00Z', confirm: true}],
  ]);
  expect((fetch as jest.Mock).mock.calls.every(([, init]) => init.headers.Authorization === 'Bearer old' && init.headers['Content-Type'] === 'application/json')).toBe(true);
});

test('write 401 refreshes once; a lost response is not replayed or failed over', async () => {
  (refresh as jest.Mock).mockResolvedValue({...session, accessToken: 'new'});
  globalThis.fetch = jest.fn().mockResolvedValueOnce({ok: false, status: 401}).mockResolvedValueOnce({ok: true, status: 204});
  const api = new BrowseApi(session, jest.fn());
  await api.retryTrash('p');
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  globalThis.fetch = jest.fn().mockRejectedValue(new TypeError('lost response'));
  const reconnect = jest.spyOn(api, 'reconnect');
  await expect(api.createFolder('new')).rejects.toThrow('lost response');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(reconnect).not.toHaveBeenCalled();
});

test('trash listing and preview are scoped and authenticated', async () => {
  globalThis.fetch = jest.fn(async () => ({ok: true, status: 200, json: async () => ({items: [], next_cursor: null, retention_days: 30})}) as Response);
  const api = new BrowseApi(session, jest.fn());
  await api.listTrash('next/1');
  expect((fetch as jest.Mock).mock.calls[0][0]).toBe(session.server + '/api/v1/trash/photos?scope=mine&cursor=next%2F1');
  expect(await api.trashPreview('p/1')).toEqual({uri: session.server + '/api/v1/trash/photos/p%2F1/preview', headers: {Authorization: 'Bearer old'}});
});

test('an ancestor write grants management but a read-only share does not', async () => {
  let permission = 'write';
  globalThis.fetch = jest.fn(async url => {
    const path = String(url).replace(session.server, '');
    const data = path === '/api/v1/auth/me' ? {id: 'me', role: 'user'} : path === '/api/v1/shares' ? {items: [{resource_id: 'root', user_id: 'me', permission}]} :
      {id: path.endsWith('/child') ? 'child' : 'root', owner_id: 'other', parent_id: path.endsWith('/child') ? 'root' : null};
    return {ok: true, status: 200, json: async () => data} as Response;
  });
  const api = new BrowseApi(session, jest.fn());
  expect((await api.writableFolder('child')).effective_permission).toBe('write');
  permission = 'read';
  expect((await api.writableFolder('child')).effective_permission).toBe('read');
});

test('map and people reads are authenticated and naming preserves the revision', async () => {
  globalThis.fetch = jest.fn(async () => ({ok: true, status: 200, json: async () => ({items: [], next_cursor: '', ok: true})}) as Response);
  const api = new BrowseApi(session, jest.fn());
  await api.mapConfig(); await api.mapPoints(); await api.faceConfig(); await api.people('next/1'); await api.personFaces('person/1', 'face/2');
  await api.renamePerson({id: 'person/1', owner_id: 'me', name: '', revision: 4, photo_count: 1, cover_face_id: 'face'}, '家人');
  await api.listPhotos(undefined, 'next', 50, false, {bbox: [170, -20, -170, 10], from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z'});
  const calls = (fetch as jest.Mock).mock.calls;
  expect(calls.slice(0, 5).map(([url]) => String(url).replace(session.server, ''))).toEqual([
    '/api/v1/map/config', '/api/v1/map/points', '/api/v1/admin/faces/config', '/api/v1/admin/people?cursor=next%2F1', '/api/v1/admin/people/person%2F1/faces?cursor=face%2F2',
  ]);
  expect(JSON.parse(calls[5][1].body)).toEqual({name: '家人', revision: 4}); expect(calls[5][1].method).toBe('PATCH');
  expect(new URL(calls[6][0]).searchParams.get('bbox')).toBe('170,-20,-170,10');
  expect(await api.faceSource('face/1')).toEqual({uri: session.server + '/api/v1/admin/faces/face%2F1/thumbnail', headers: {Authorization: 'Bearer old'}});
});
