import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {BackHandler} from 'react-native';
import {BrowseApi, type PhotoPage} from '../src/browse/api';
import {usePhotos} from '../src/browse/usePhotos';
import {usePhotoSelection} from '../src/browse/PhotoActions';

jest.useRealTimers();
jest.mock('../src/auth/session', () => ({saveSession: jest.fn(), clearSession: jest.fn()}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const photo = (id: string) => ({id, owner_id: 'me', folder_id: 'f', filename: `${id}.jpg`, mime_type: 'image/jpeg', captured_at: '2026-09-30T12:00:00Z', size: 10});
let renderer: ReactTestRenderer;
let page: ReturnType<typeof usePhotos>;
const api = {subscribe: () => () => {}, getRevision: () => 0, listPhotos: jest.fn(), liveStatus: jest.fn().mockResolvedValue([])} as unknown as BrowseApi;
function Photos({q}: {q: string}) {page = usePhotos(api, 'f', true, {q, mediaType: 'video'}); return null;}
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
