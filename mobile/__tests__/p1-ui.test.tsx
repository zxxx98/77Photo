import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {FlatList, Linking, Text, TextInput} from 'react-native';
import {ApiError} from '../src/auth/api';
import {BrowseApi, type Person, type Photo} from '../src/browse/api';
import PeoplePage from '../src/browse/PeoplePage';
import PhotoDetails, {amapURL, photoLocation} from '../src/browse/PhotoDetails';
import MapPage from '../src/map/MapPage';
import PhotoMap from '../src/map/PhotoMap';
import {PhotoClusters, toLocatedPhotos} from '../src/map/clusters';

jest.useRealTimers();
jest.mock('../src/auth/session', () => ({saveSession: jest.fn(), clearSession: jest.fn()}));
jest.mock('../src/map/PhotoMap', () => {
  const {View} = require('react-native');
  return function MockMap(props: object) {return <View testID="photo-map" {...props} />;};
});
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer;
const photo: Photo = {id: 'p', owner_id: 'me', folder_id: 'f', filename: 'pic.jpg', mime_type: 'image/jpeg', captured_at: '2026-09-30T12:00:00Z', size: 100, width: 200, height: 100};
const person: Person = {id: 'person', owner_id: 'me', name: '', revision: 3, photo_count: 1, cover_face_id: 'face'};
function fakeApi(input: Record<string, unknown> = {}) {
  return {subscribe: () => () => {}, getRevision: () => 0, me: jest.fn().mockResolvedValue({id: 'me', role: 'admin'}), faceConfig: jest.fn().mockResolvedValue({enabled: true}),
    people: jest.fn().mockResolvedValue({items: [person], next_cursor: ''}), personFaces: jest.fn().mockResolvedValue({items: [], next_cursor: ''}), renamePerson: jest.fn().mockResolvedValue({ok: true}),
    faceSource: jest.fn().mockResolvedValue({uri: 'https://example.test/face'}), mediaSource: jest.fn().mockResolvedValue({uri: 'https://example.test/thumb'}),
    photo: jest.fn().mockResolvedValue(photo), mapConfig: jest.fn().mockResolvedValue({enabled: true, min_zoom: 1, max_zoom: 18}), mapPoints: jest.fn().mockResolvedValue({items: [], total_photos: 0}),
    listPhotos: jest.fn().mockResolvedValue({items: [], next_cursor: null}), liveStatus: jest.fn().mockResolvedValue([]), ...input} as unknown as BrowseApi;
}
async function render(element: React.ReactElement) {await act(async () => {renderer = create(element);});}
function renderedText() {return renderer.root.findAllByType(Text).map(node => React.Children.toArray(node.props.children).filter(child => typeof child === 'string' || typeof child === 'number').join('')).join(' ');}
function button(label: string) {return renderer.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];}
async function press(label: string) {await act(async () => {button(label).props.onPress();});}
async function settleMap() {await act(async () => {await new Promise<void>(resolve => setTimeout(resolve, 280));});}
afterEach(async () => {if (renderer) {await act(async () => renderer.unmount());} jest.restoreAllMocks();});

test('non-admin and disabled face recognition never request a people listing', async () => {
  const api = fakeApi({me: jest.fn().mockResolvedValue({role: 'user'})});
  await render(<PeoplePage api={api} close={jest.fn()} open={jest.fn()} />);
  expect(api.faceConfig).not.toHaveBeenCalled(); expect(api.people).not.toHaveBeenCalled(); expect(renderedText()).toContain('仅对管理员');
  await act(async () => {renderer.unmount();});
  const disabled = fakeApi({faceConfig: jest.fn().mockResolvedValue({enabled: false})});
  await render(<PeoplePage api={disabled} close={jest.fn()} open={jest.fn()} />);
  expect(disabled.people).not.toHaveBeenCalled(); expect(renderedText()).toContain('尚未启用');
});

test('people paginate, person photos deduplicate and naming uses a revision', async () => {
  const people = jest.fn().mockResolvedValueOnce({items: [person], next_cursor: 'next'}).mockResolvedValue({items: [{...person, id: 'other', name: '朋友'}], next_cursor: ''});
  const faces = [{id: 'f1', photo_id: 'p', filename: 'pic.jpg'}, {id: 'f2', photo_id: 'p', filename: 'pic.jpg'}];
  const api = fakeApi({people, personFaces: jest.fn().mockResolvedValue({items: faces, next_cursor: ''})});
  const open = jest.fn();
  await render(<PeoplePage api={api} close={jest.fn()} open={open} />);
  await press('加载更多人物'); expect(people).toHaveBeenLastCalledWith('next');
  await press('查看人物 未命名人物 · person');
  expect(renderer.root.findAll(node => node.props.accessibilityLabel === '查看 pic.jpg' && typeof node.props.onPress === 'function')).toHaveLength(1);
  await press('查看 pic.jpg'); expect(open).toHaveBeenCalledWith(expect.objectContaining(photo), [expect.objectContaining(photo)]);
  await press('人物命名'); await act(async () => {renderer.root.findByType(TextInput).props.onChangeText(' 家人 ');}); await press('保存人物名称');
  expect(api.renamePerson).toHaveBeenCalledWith(person, '家人'); expect(renderedText()).toContain('家人');
});

test('a naming revision conflict keeps the dialog and the prior name', async () => {
  const api = fakeApi({renamePerson: jest.fn().mockRejectedValue(new ApiError(409, 'FACE_CONFLICT', 'conflict'))});
  await render(<PeoplePage api={api} close={jest.fn()} open={jest.fn()} />);
  await press('查看人物 未命名人物 · person'); await press('人物命名');
  await act(async () => {renderer.root.findByType(TextInput).props.onChangeText('家人');}); await press('保存人物名称');
  expect(renderer.root.findByType(TextInput).props.value).toBe('家人'); expect(renderedText()).toContain('刷新人物列表');
});

test('details accept zero coordinates, obey disabled maps and launch WGS84 Amap links', async () => {
  const located = {...photo, gps_latitude: 0, gps_longitude: 0};
  const api = fakeApi({mapConfig: jest.fn().mockResolvedValue({enabled: false})});
  const onMap = jest.fn(); const link = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  await render(<PhotoDetails api={api} photo={located} folderName="家庭" close={jest.fn()} onMap={onMap} />);
  expect(renderer.root.findAllByType(PhotoMap)).toHaveLength(0); expect(button('在地图相册中查看')).toBeUndefined();
  await press('在高德地图中打开'); expect(link).toHaveBeenCalledWith(amapURL(0, 0));
  expect(photoLocation({...photo, gps_latitude: NaN, gps_longitude: 10})).toBeNull(); expect(photoLocation(photo)).toBeNull();
});

test('enabled location details show a pin and focus the full map; missing metadata stays hidden', async () => {
  const api = fakeApi(); const onMap = jest.fn(); const close = jest.fn();
  await render(<PhotoDetails api={api} photo={{...photo, gps_latitude: 31.23, gps_longitude: 121.47}} folderName="家庭" close={close} onMap={onMap} />);
  expect(renderer.root.findByType(PhotoMap).props.mini).toBe(true); await press('在地图相册中查看');
  expect(close).toHaveBeenCalled(); expect(onMap).toHaveBeenCalledWith({lat: 31.23, lng: 121.47, zoom: 16});
  await act(async () => renderer.unmount()); const noLocation = fakeApi();
  await render(<PhotoDetails api={noLocation} photo={{...photo, width: undefined, height: undefined}} folderName="" close={jest.fn()} onMap={jest.fn()} />);
  expect(noLocation.mapConfig).not.toHaveBeenCalled(); expect(renderedText()).not.toContain('尺寸：');
});

test('map viewport and year queries paginate; co-located cluster opens the place list', async () => {
  const points = [['p', 31.23, 121.47, '2026-09-30T00:00:00Z'], ['q', 31.23, 121.47, '2026-08-01T00:00:00Z']] as [string, number, number, string][];
  const api = fakeApi({mapPoints: jest.fn().mockResolvedValue({items: points, total_photos: 3}), listPhotos: jest.fn().mockResolvedValue({items: [photo], next_cursor: 'more'})});
  const open = jest.fn();
  await render(<MapPage api={api} close={jest.fn()} open={open} />); await settleMap();
  await press('2026 年'); expect(api.listPhotos).toHaveBeenLastCalledWith(undefined, undefined, 50, false, expect.objectContaining({from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z', bbox: expect.any(Array)}));
  await act(async () => {renderer.root.findByType(FlatList).props.onEndReached();});
  expect(api.listPhotos).toHaveBeenLastCalledWith(undefined, 'more', 50, false, expect.objectContaining({from: '2026-01-01T00:00:00Z', bbox: expect.any(Array)}));
  const clusters = new PhotoClusters(toLocatedPhotos(points), 18); const spec = clusters.markers([121, 31, 122, 32], 18, 121)[0];
  await act(async () => {renderer.root.findByType(PhotoMap).props.marker(spec, clusters);});
  expect(button('返回当前区域')).toBeDefined(); await press('查看 pic.jpg'); expect(open).toHaveBeenCalledWith(expect.objectContaining(photo), [expect.objectContaining(photo)]);
});
