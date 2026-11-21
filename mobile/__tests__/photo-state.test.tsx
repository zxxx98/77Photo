import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {BackHandler} from 'react-native';
import {BrowseApi, type PhotoPage} from '../src/browse/api';
import {mergeFirstPage, usePhotos} from '../src/browse/usePhotos';
import {usePhotoSelection} from '../src/browse/PhotoActions';

jest.useRealTimers();
jest.mock('../src/auth/session', () => ({saveSession: jest.fn(), clearSession: jest.fn()}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const photo = (id: string) => ({id, owner_id: 'me', folder_id: 'f', filename: `${id}.jpg`, mime_type: 'image/jpeg', captured_at: '2026-09-30T12:00:00Z', size: 10});
let renderer: ReactTestRenderer;
let page: ReturnType<typeof usePhotos>;
const api = {subscribe: () => () => {}, getRevision: () => 0, onPhotoChange: () => () => {}, listPhotos: jest.fn(), liveStatus: jest.fn().mockResolvedValue([])} as unknown as BrowseApi;
function Photos({q}: {q: string}) {page = usePhotos(api, 'f', true, {q, mediaType: 'video'}); return null;}
// A real client, so revisions and change events behave as they do in the app.
function liveApi() {
  const real = new BrowseApi({server: 'https://photos.test', username: 'alice', accessToken: 'a', accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(), refreshToken: 'r', refreshExpiresAt: ''}, jest.fn());
  const listPhotos = jest.spyOn(real, 'listPhotos');
  jest.spyOn(real, 'liveStatus').mockResolvedValue([]);
  return {real, listPhotos};
}
function Library({client, favorite = false}: {client: BrowseApi; favorite?: boolean}) {page = usePhotos(client, undefined, favorite); return null;}
const ids = () => page.items.map(item => item.id);
afterEach(async () => {if (renderer) {await act(async () => renderer.unmount());} jest.restoreAllMocks();});

test('loading more retains search filters and ignores a stale result after filters change', async () => {
  let oldResult!: (value: PhotoPage) => void;
  (api.listPhotos as jest.Mock).mockReset().mockResolvedValueOnce({items: [photo('a')], next_cursor: 'next', favorites_supported: true})
    .mockImplementationOnce(() => new Promise<PhotoPage>(resolve => {oldResult = resolve;}))
    .mockResolvedValueOnce({items: [photo('new')], next_cursor: null, favorites_supported: true});
  await act(async () => {renderer = create(<Photos q="old" />);});
  await act(async () => {page.loadMore();});
  expect(api.listPhotos).toHaveBeenLastCalledWith('f', 'next', 50, true, {q: 'old', mediaType: 'video', from: undefined, to: undefined});
  await act(async () => {renderer.update(<Photos q="new" />);});
  await act(async () => {oldResult({items: [photo('stale')], next_cursor: null});});
  expect(page.items.map(item => item.id)).toEqual(['new']); expect(page.cursor).toBeNull();
});

test('selection supports individual and day toggles; Android back exits selection first', async () => {
  let selection!: ReturnType<typeof usePhotoSelection>;
  let back!: () => boolean;
  const remove = jest.fn();
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, callback) => {back = callback as () => boolean; return {remove};});
  function Selection() {selection = usePhotoSelection(); return null;}
  await act(async () => {renderer = create(<Selection />);});
  await act(async () => {selection.start('a');});
  expect(selection.ids.has('a')).toBe(true);
  await act(async () => {selection.toggleDay([photo('a'), photo('b')]);});
  expect([...selection.ids]).toEqual(['a', 'b']);
  await act(async () => {selection.toggleDay([photo('a'), photo('b')]);});
  expect(selection.ids.size).toBe(0);
  await act(async () => {selection.toggle('b');});
  expect(selection.ids.has('b')).toBe(true);
  await act(async () => {expect(back()).toBe(true);});
  expect(selection.selecting).toBe(false); expect(selection.ids.size).toBe(0); expect(remove).toHaveBeenCalled();
});

test('a refresh hint keeps the loaded pages on screen and splices in the new first page', async () => {
  const {real, listPhotos} = liveApi();
  listPhotos.mockResolvedValueOnce({items: [photo('a'), photo('b')], next_cursor: 'c1'})
    .mockResolvedValueOnce({items: [photo('c'), photo('d')], next_cursor: 'c2'});
  await act(async () => {renderer = create(<Library client={real} />);});
  await act(async () => {page.loadMore();});
  expect(ids()).toEqual(['a', 'b', 'c', 'd']);
  let answer!: (value: PhotoPage) => void;
  listPhotos.mockImplementationOnce(() => new Promise<PhotoPage>(resolve => {answer = resolve;}));
  await act(async () => {real.refreshBrowsing();});
  // Nothing is cleared while the request is in flight.
  expect(page.state).toBe('ready'); expect(ids()).toEqual(['a', 'b', 'c', 'd']);
  // 'a' was deleted elsewhere and 'new' was added; the loaded tail and its cursor survive.
  await act(async () => {answer({items: [photo('new'), photo('b')], next_cursor: 'ignored'});});
  expect(ids()).toEqual(['new', 'b', 'c', 'd']); expect(page.cursor).toBe('c2');
});

test('a failed refresh hint leaves the list alone; an explicit reset reloads from scratch', async () => {
  const {real, listPhotos} = liveApi();
  listPhotos.mockResolvedValueOnce({items: [photo('a')], next_cursor: null}).mockRejectedValueOnce(new TypeError('offline'));
  await act(async () => {renderer = create(<Library client={real} />);});
  await act(async () => {real.refreshBrowsing();});
  expect(page.state).toBe('ready'); expect(ids()).toEqual(['a']);
  let answer!: (value: PhotoPage) => void;
  listPhotos.mockImplementationOnce(() => new Promise<PhotoPage>(resolve => {answer = resolve;}));
  await act(async () => {real.refreshBrowsing(true);});
  expect(page.state).toBe('loading'); expect(ids()).toEqual([]);
  await act(async () => {answer({items: [photo('z')], next_cursor: null});});
  expect(ids()).toEqual(['z']);
});

test('deletions and favorites update loaded lists without another request', async () => {
  const {real, listPhotos} = liveApi();
  listPhotos.mockResolvedValueOnce({items: [{...photo('a'), is_favorite: false}, photo('b')], next_cursor: null});
  await act(async () => {renderer = create(<Library client={real} />);});
  await act(async () => {real.photoFavorited('a', true);});
  expect(page.items[0].is_favorite).toBe(true);
  await act(async () => {real.photosRemoved(['a']);});
  expect(ids()).toEqual(['b']); expect(page.state).toBe('ready');
  await act(async () => {real.photosRemoved(['b']);});
  expect(page.state).toBe('empty'); expect(listPhotos).toHaveBeenCalledTimes(1);
});

test('a favorites list drops an unfavorited photo and refetches for one it never had', async () => {
  const {real, listPhotos} = liveApi();
  listPhotos.mockResolvedValueOnce({items: [photo('a'), photo('b')], next_cursor: null, favorites_supported: true})
    .mockResolvedValueOnce({items: [photo('a'), photo('b')], next_cursor: null, favorites_supported: true});
  await act(async () => {renderer = create(<Library client={real} favorite />);});
  await act(async () => {real.photoFavorited('b', false);});
  expect(ids()).toEqual(['a']); expect(listPhotos).toHaveBeenCalledTimes(1);
  await act(async () => {real.photoFavorited('b', true);});
  expect(ids()).toEqual(['a', 'b']); expect(listPhotos).toHaveBeenCalledTimes(2);
});

test('pull-to-refresh reports progress and replaces the list', async () => {
  const {real, listPhotos} = liveApi();
  listPhotos.mockResolvedValueOnce({items: [photo('a')], next_cursor: 'old'});
  await act(async () => {renderer = create(<Library client={real} />);});
  let answer!: (value: PhotoPage) => void;
  listPhotos.mockImplementationOnce(() => new Promise<PhotoPage>(resolve => {answer = resolve;}));
  await act(async () => {page.refresh();});
  expect(page.refreshing).toBe(true); expect(ids()).toEqual(['a']);
  await act(async () => {answer({items: [photo('x')], next_cursor: null});});
  expect(page.refreshing).toBe(false); expect(ids()).toEqual(['x']); expect(page.cursor).toBeNull();
});

test('mergeFirstPage keeps the tail only when the pages still overlap', () => {
  const old = [photo('a'), photo('b'), photo('c')];
  expect(mergeFirstPage(old, [photo('a'), photo('b')])?.map(item => item.id)).toEqual(['a', 'b', 'c']);
  expect(mergeFirstPage(old, [photo('n'), photo('a')])?.map(item => item.id)).toEqual(['n', 'a', 'b', 'c']);
  expect(mergeFirstPage([{...photo('a'), is_live_photo: true}], [photo('a')])?.[0].is_live_photo).toBe(true);
  expect(mergeFirstPage(old, [photo('x'), photo('y')])).toBeNull();
  expect(mergeFirstPage(old, [])).toBeNull();
});
