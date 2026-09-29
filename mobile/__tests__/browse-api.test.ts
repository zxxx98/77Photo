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
