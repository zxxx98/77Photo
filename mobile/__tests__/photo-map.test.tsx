import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {Image, PanResponder} from 'react-native';
import type {BrowseApi} from '../src/browse/api';
import PhotoMap from '../src/map/PhotoMap';

jest.mock('../src/browse/MediaThumbnail', () => () => null);
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer;
afterEach(async () => {await act(async () => renderer?.unmount()); jest.restoreAllMocks();});
test('map tiles have no session headers; failed tiles retry and markers open', async () => {
  const marker = jest.fn(); const change = jest.fn();
  await act(async () => {renderer = create(<PhotoMap api={{} as BrowseApi} config={{enabled: true, min_zoom: 1, max_zoom: 18, tile_layers: [{url: 'https://tiles.test/{z}/{x}/{y}', subdomains: ''}]}} photos={[{id: 'p', lat: 0, lng: 0, capturedAt: '2026-01-01T00:00:00Z'}]} view={{lat: 0, lng: 0, zoom: 3}} change={change} marker={marker} />);});
  const tiles = renderer.root.findAllByType(Image);
  expect(tiles.length).toBeGreaterThanOrEqual(4);
  for (const tile of tiles) {expect(tile.props.source).toEqual({uri: expect.stringMatching(/^https:\/\/tiles.test\//)});}
  const press = (label: string) => renderer.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];
  await act(async () => {tiles.forEach(tile => tile.props.onError());});
  expect(press('重试底图')).toBeDefined();
  await act(async () => {press('重试底图').props.onPress();});
  expect(press('重试底图')).toBeUndefined();
  await act(async () => {press('查看此地点照片').props.onPress(); press('放大地图').props.onPress();});
  expect(marker).toHaveBeenCalledWith(expect.objectContaining({coverId: 'p'}), expect.anything());
  expect(change).toHaveBeenCalledWith({lat: 0, lng: 0, zoom: 4});
});
test('drag and pinch preserve the current zoom when returning to one finger', async () => {
  const spy = jest.spyOn(PanResponder, 'create'); const change = jest.fn();
  await act(async () => {renderer = create(<PhotoMap api={{} as BrowseApi} config={{enabled: true}} photos={[]} view={{lat: 0, lng: 0, zoom: 3}} change={change} />);});
  const handlers = spy.mock.calls[0][0];
  const event = (distance: number) => ({nativeEvent: {touches: distance ? [{pageX: 0, pageY: 0}, {pageX: distance, pageY: 0}] : [{pageX: 0, pageY: 0}]}});
  const gesture = {dx: 20, dy: 0};
  handlers.onPanResponderGrant!(event(100) as never, gesture as never);
  handlers.onPanResponderMove!(event(200) as never, gesture as never);
  expect(change).toHaveBeenLastCalledWith({lat: 0, lng: 0, zoom: 4});
  await act(async () => {renderer.update(<PhotoMap api={{} as BrowseApi} config={{enabled: true}} photos={[]} view={{lat: 0, lng: 0, zoom: 4}} change={change} />);});
  handlers.onPanResponderMove!(event(0) as never, gesture as never);
  handlers.onPanResponderMove!(event(0) as never, {...gesture, dx: 40} as never);
  expect(change).toHaveBeenLastCalledWith(expect.objectContaining({zoom: 4, lng: expect.any(Number)}));
});
