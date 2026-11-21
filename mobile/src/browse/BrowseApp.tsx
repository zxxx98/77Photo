import NetInfo from '@react-native-community/netinfo';
import ServerAddresses from '../auth/ServerAddresses';
import UpdateSettings from '../update/UpdateSettings';
import React, {memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {ActivityIndicator, AppState, BackHandler, FlatList, Image, NativeModules, Pressable, ScrollView, StatusBar, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import Video from 'react-native-video';
import ReactNativeBlobUtil from 'react-native-blob-util';
import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
import {ApiError} from '../auth/api';
import type {MobileSession} from '../auth/session';
import {BrowseApi, errorState, groupPhotos, type Folder, type LoadState, type MediaSource, type Photo} from './api';
import {usePhotos} from './usePhotos';
import UploadPage from '../upload/UploadPage';
import Icon from './Icon';
import {Action, CreateFolder, Sheet, ui} from './ManagementUI';
import PhotoFilters, {emptyFilters, hasFilters, queryFilters, type GalleryFilters} from './PhotoFilters';
import {PhotoActions, usePhotoSelection} from './PhotoActions';
import TrashPage from './TrashPage';
import PhotoDetails from './PhotoDetails';
import PeoplePage from './PeoplePage';
import MapPage from '../map/MapPage';
import type {MapFocus} from '../map/geometry';

const ink = '#3D4A5C';
const muted = '#75808A';
const paper = '#FAF9F7';
const border = '#E8E5E1';

function StateView({state, retry}: {state: LoadState; retry: () => void}) {
  const copy: Record<LoadState, string> = {
    loading: '正在加载…', ready: '', empty: '这里还没有内容',
    offline: '无法连接服务器，请检查网络', forbidden: '没有权限查看这些内容',
    expired: '登录已失效，请重新登录', failed: '加载失败，请重试',
  };
  if (state === 'ready') {return null;}
  return <View style={styles.state}>
    {state === 'loading' ? <ActivityIndicator color={ink} /> : null}
    <Text style={styles.stateText}>{copy[state]}</Text>
    {['offline', 'failed'].includes(state) ? <Pressable accessibilityRole="button" style={styles.retry} onPress={retry}><Text style={styles.retryText}>重试</Text></Pressable> : null}
  </View>;
}

// A stable function that always calls the latest closure, so memoized tiles
// are not re-rendered merely because their parent rendered again.
function useEvent<Args extends unknown[], Result>(handler: (...args: Args) => Result): (...args: Args) => Result {
  const latest = useRef(handler);
  latest.current = handler;
  return useCallback((...args: Args) => latest.current(...args), []);
}
const sameSource = (a: MediaSource | undefined, b: MediaSource) => a?.uri === b.uri && a.headers.Authorization === b.headers.Authorization;

const MediaTile = memo(function Tile({api, photo, size, press, longPress, selected}: {api: BrowseApi; photo: Photo; size: number; press: (photo: Photo) => void; longPress: (photo: Photo) => void; selected?: boolean}) {
  const revision = useSyncExternalStore(api.subscribe, api.getRevision);
  // Start from the current session so the image request begins on first render.
  const [source, setSource] = useState<MediaSource | undefined>(() => api.peekMediaSource(photo.id, 'thumbnail'));
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setFailed(false);
    api.mediaSource(photo.id, 'thumbnail').then(value => {
      // Keep the object when nothing changed, except after an error retry.
      if (live) {setSource(old => attempt === 0 && sameSource(old, value) ? old : value);}
    }).catch(() => {if (live) {setFailed(true);}});
    return () => {live = false;};
  }, [api, photo.id, attempt, revision]);
  function imageError() {
    if (attempt < 2) {api.reconnect().then(() => {setFailed(false); setAttempt(attempt + 1);}).catch(() => setFailed(true));}
    else {setFailed(true);}
  }
  return <Pressable style={[styles.tile, {width: size, height: size}]} accessibilityRole="button"
    accessibilityLabel={`${photo.is_live_photo ? '动态照片' : photo.mime_type.startsWith('video/') ? '视频' : '照片'}，${photo.filename}`}
    onPress={() => press(photo)} onLongPress={() => longPress(photo)} accessibilityState={selected === undefined ? undefined : {selected}}>
    {source && !failed ? <Image source={source} style={styles.tileImage} onError={imageError} resizeMode="cover" /> :
      <Text style={styles.tileFallback}>{failed ? '预览失败' : ''}</Text>}
    {selected !== undefined ? <Text style={[styles.selectionBadge, selected && styles.selectionChecked]}>{selected ? '✓' : '○'}</Text> : null}
    {photo.is_live_photo ? <Text style={styles.badge}>LIVE</Text> : photo.mime_type.startsWith('video/') ? <View style={styles.badgeRow}><Icon name="video" tone="light" size={15} /><Text style={styles.badgeLabel}>视频</Text></View> : null}
  </Pressable>;
});

// One grid row. `press` and `longPress` must be stable (see useEvent).
const MediaRow = memo(function Row({api, photos, press, longPress, selected}: {api: BrowseApi; photos: Photo[]; press: (photo: Photo) => void; longPress: (photo: Photo) => void; selected?: Set<string>}) {
  const {width} = useWindowDimensions();
  const size = Math.floor((width - 36) / 3);
  return <View style={styles.grid}>{photos.map(photo => <MediaTile key={photo.id} api={api} photo={photo} size={size} selected={selected?.has(photo.id)} press={press} longPress={longPress} />)}</View>;
});
function photoRows(photos: Photo[]): Photo[][] {
  const rows: Photo[][] = [];
  for (let offset = 0; offset < photos.length; offset += 3) {rows.push(photos.slice(offset, offset + 3));}
  return rows;
}

function FolderCover({api, folder}: {api: BrowseApi; folder: Folder}) {
  const revision = useSyncExternalStore(api.subscribe, api.getRevision);
  const [source, setSource] = useState<{uri: string; headers: {Authorization: string}}>();
  useEffect(() => {
    let active = true;
    api.listPhotos(folder.id, undefined, 1).then(page => page.items[0] ? api.mediaSource(page.items[0].id, 'thumbnail') : undefined)
      .then(value => {if (active) {setSource(value);}}).catch(() => {});
    return () => {active = false;};
  }, [api, folder.id, revision]);
  return <View style={styles.folderIcon}>{source ? <Image source={source} style={styles.folderImage} /> : <Icon name="folders" size={24} />}</View>;
}

function Photos({api, active, open, settings, trash, map, people}: {api: BrowseApi; active: boolean; open: (photo: Photo, all: Photo[]) => void; settings: () => void; trash: () => void; map: () => void; people?: () => void}) {
  const [favorite, setFavorite] = useState(false);
  const [filters, setFilters] = useState<GalleryFilters>(emptyFilters);
  const [filtering, setFiltering] = useState(false);
  const selection = usePhotoSelection();
  const page = usePhotos(api, filters.folder?.id, favorite, queryFilters(filters));
  // The page stays mounted behind other tabs; a hidden selection must not
  // linger there and swallow the Android Back button.
  const resetSelection = selection.reset;
  useEffect(() => {if (!active) {resetSelection();}}, [active, resetSelection]);
  const [libraryEmpty, setLibraryEmpty] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    setLibraryEmpty(null);
    if (page.state === 'empty' && (hasFilters(filters) || favorite)) {
      api.listPhotos(undefined, undefined, 1).then(result => {if (live) {setLibraryEmpty(result.items.length === 0);}}).catch(() => {});
    }
    return () => {live = false;};
  }, [api, page.state, filters, favorite]);
  useEffect(() => {if (favorite && page.state === 'ready' && !page.favoritesSupported) {setFavorite(false);}}, [favorite, page.state, page.favoritesSupported]);
  const timeline = useMemo(() => groupPhotos(page.items).flatMap(group => {
    const rows: ({type: 'date'; key: string; date: string; photos: Photo[]} | {type: 'row'; key: string; photos: Photo[]})[] =
      [{type: 'date', key: group.date, date: group.date, photos: group.items}];
    for (const photos of photoRows(group.items)) {rows.push({type: 'row', key: photos[0].id, photos});}
    return rows;
  }), [page.items]);
  const press = useEvent((photo: Photo) => {if (selection.selecting) {selection.toggle(photo.id);} else {open(photo, page.items);}});
  const longPress = useEvent((photo: Photo) => selection.start(photo.id));
  return <View style={styles.page}>
    <View style={styles.topRow}><Text style={styles.title}>77Photo</Text><Pressable style={styles.settingsButton} accessibilityRole="button" accessibilityLabel="设置" onPress={settings}><Icon name="settings" size={22} /></Pressable></View>
    <View style={ui.row}>
      <Action label={hasFilters(filters) ? '搜索与筛选 · 已应用' : '搜索与筛选'} selected={hasFilters(filters)} onPress={() => setFiltering(true)} />
      {page.favoritesSupported ? <Action label="♥ 收藏" selected={favorite} onPress={() => {selection.reset(); setFavorite(value => !value);}} /> : null}
      <Action label="地图" onPress={map} />
      {people ? <Action label="人物" onPress={people} /> : null}
      <Action label="回收站" onPress={trash} />
      {!selection.selecting ? <Action label="选择" disabled={!page.items.length} onPress={() => selection.start()} /> : null}
    </View>
    {hasFilters(filters) ? <View style={ui.row}><Text style={styles.path}>{[filters.q && `名称：${filters.q}`, filters.folder?.name, filters.fromDate && `从 ${filters.fromDate}`, filters.toDate && `至 ${filters.toDate}`, filters.mediaType === 'photo' ? '照片' : filters.mediaType === 'video' ? '视频' : ''].filter(Boolean).join(' · ')}</Text><Action label="清除筛选" onPress={() => {selection.reset(); setFilters(emptyFilters);}} /></View> : null}
    {page.state === 'empty' ? <View style={styles.state}><Text style={styles.stateText}>{(hasFilters(filters) || favorite) && libraryEmpty !== true ? '没有匹配的照片，试试清除筛选或收藏条件' : '图库还没有照片'}</Text></View> : page.state !== 'ready' ? <StateView state={page.state} retry={page.refresh} /> :
      <FlatList data={timeline} extraData={selection.ids} keyExtractor={item => item.key} onEndReached={() => {if (page.cursor && page.moreState === 'ready') {page.loadMore();}}}
        onEndReachedThreshold={0.4} windowSize={7} initialNumToRender={8} refreshing={page.refreshing} onRefresh={() => {selection.reset(); page.refresh();}}
        renderItem={({item}) => item.type === 'date' ? <View style={ui.row}><Text style={styles.date}>{item.date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_, y, m, d) => `${y}年${Number(m)}月${Number(d)}日`)}</Text>{selection.selecting ? <Action label={item.photos.every(photo => selection.ids.has(photo.id)) ? '取消当天' : '选择当天'} onPress={() => selection.toggleDay(item.photos)} /> : null}</View> :
          <MediaRow api={api} photos={item.photos} selected={selection.selecting ? selection.ids : undefined} press={press} longPress={longPress} />}
        ListFooterComponent={page.moreState === 'loading' ? <ActivityIndicator color={ink} /> : page.moreState !== 'ready' ? <StateView state={page.moreState} retry={page.loadMore} /> : undefined}
        contentContainerStyle={styles.list} />}
    {selection.selecting ? <PhotoActions api={api} photos={page.items.filter(photo => selection.ids.has(photo.id))} completed={page.remove} retain={ids => selection.setIds(new Set(ids))} close={selection.reset} /> : null}
    {filtering ? <PhotoFilters api={api} value={filters} close={() => setFiltering(false)} apply={value => {selection.reset(); setFilters(value);}} /> : null}
  </View>;
}

function Folders({api, active, stack, setStack, open, settings, upload}: {api: BrowseApi; active: boolean; stack: Folder[]; setStack: (folders: Folder[]) => void; open: (photo: Photo, all: Photo[]) => void; settings: () => void; upload: (folder: Folder) => void}) {
  const revision = useSyncExternalStore(api.subscribe, api.getRevision);
  const current = stack[stack.length - 1];
  const folderGeneration = useRef(0);
  // The folder whose listing is on screen; '' is the root, null is nothing.
  const shown = useRef<string | null>(null);
  const [creating, setCreating] = useState(false);
  const selection = usePhotoSelection();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const page = usePhotos(api, current?.id, false, {}, !!current);
  const load = useCallback(async () => {
    const ticket = ++folderGeneration.current;
    const id = current?.id ?? '';
    // Reloading the folder already on screen keeps its rows until the answer arrives.
    if (shown.current !== id) {shown.current = null; setState('loading'); setFolders([]);}
    try {const result = await api.listFolders(current?.id); if (ticket === folderGeneration.current) {shown.current = id; setFolders(result); setState(result.length ? 'ready' : 'empty');}}
    catch (error) {if (ticket === folderGeneration.current) {shown.current = null; setFolders([]); setState(errorState(error));}}
  }, [api, current?.id]);
  useEffect(() => {load(); const ticket = folderGeneration.current; return () => {folderGeneration.current = ticket + 1;};}, [load, revision]);
  const resetSelection = selection.reset;
  useEffect(() => {resetSelection();}, [current?.id, active, resetSelection]);
  const rows = useMemo(() => photoRows(page.items), [page.items]);
  const press = useEvent((photo: Photo) => {if (selection.selecting) {selection.toggle(photo.id);} else {open(photo, page.items);}});
  const longPress = useEvent((photo: Photo) => selection.start(photo.id));
  return <View style={styles.page}>
    <View style={styles.headingRow}>{current ? <Pressable accessibilityRole="button" accessibilityLabel="返回上级文件夹" style={styles.back} onPress={() => setStack(stack.slice(0, -1))}><Icon name="back" size={24} /></Pressable> : null}
      <Text style={styles.folderHeading} numberOfLines={1}>{current?.name ?? '文件夹'}</Text><View style={styles.headingActions}>{current?.effective_permission === 'write' ? <Pressable style={styles.headerAction} accessibilityRole="button" accessibilityLabel={`上传到 ${current.name}`} onPress={() => upload(current)}><Icon name="plus" size={22} /></Pressable> : null}<Pressable style={styles.headerAction} accessibilityRole="button" accessibilityLabel="设置" onPress={settings}><Icon name="settings" size={22} /></Pressable></View></View>
    <View style={ui.row}>
      {!current || current.effective_permission === 'write' ? <Action label="新建文件夹" disabled={state === 'loading' || ['offline', 'failed', 'forbidden', 'expired'].includes(state)} onPress={() => setCreating(true)} /> : null}
      {current && !selection.selecting ? <Action label="选择照片" disabled={!page.items.length} onPress={() => selection.start()} /> : null}
    </View>
    <FlatList data={current && page.state === 'ready' ? rows : []} extraData={selection.ids} keyExtractor={row => row[0].id} contentContainerStyle={styles.list}
      onEndReached={() => {if (current && page.cursor && page.moreState === 'ready') {page.loadMore();}}} onEndReachedThreshold={0.4} windowSize={7} initialNumToRender={8}
      refreshing={!!current && page.refreshing} onRefresh={() => {selection.reset(); load(); if (current) {page.refresh();}}}
      renderItem={({item}) => <MediaRow api={api} photos={item} selected={selection.selecting ? selection.ids : undefined} press={press} longPress={longPress} />}
      ListHeaderComponent={<>
        {stack.length ? <Text style={styles.path}>{stack[0].is_shared ? '共享文件夹' : '我的文件夹'} / {stack.map(f => f.name).join(' / ')}</Text> : null}
        {state === 'ready' ? folders.map(folder => <Pressable key={folder.id} accessibilityRole="button" accessibilityLabel={`进入文件夹 ${folder.name}`} style={styles.folder} onPress={() => setStack([...stack, folder])}>
          <FolderCover api={api} folder={folder} /><View style={styles.folderCopy}>
            <Text style={styles.folderName}>{folder.name}</Text><Text style={styles.meta}>{folder.photo_count ?? 0} 个媒体 · {folder.child_folder_count ?? 0} 个子文件夹{folder.is_shared ? ' · 共享' : ''}</Text>
            <Text style={styles.meta}>{folder.effective_permission === 'write' ? '可编辑' : '只读'}</Text></View><Icon name="next" tone="muted" size={20} />
          </Pressable>) : state !== 'empty' ? <StateView state={state} retry={load} /> : null}
        {current ? <>
          <Text style={styles.section}>此目录及子目录媒体</Text>
          {page.state !== 'ready' ? <StateView state={page.state} retry={page.refresh} /> : null}
        </> : state === 'empty' ? <StateView state="empty" retry={load} /> : null}
      </>}
      ListFooterComponent={!current || page.state !== 'ready' ? undefined : page.moreState === 'loading' ? <ActivityIndicator style={styles.moreSpinner} color={ink} /> : page.moreState !== 'ready' ? <StateView state={page.moreState} retry={page.loadMore} /> : undefined} />
    {selection.selecting ? <PhotoActions api={api} photos={page.items.filter(photo => selection.ids.has(photo.id))} completed={ids => {page.remove(ids); load();}} retain={ids => selection.setIds(new Set(ids))} close={selection.reset} /> : null}
    {creating ? <CreateFolder api={api} parent={current} close={() => setCreating(false)} created={() => {load();}} /> : null}
  </View>;
}

function Viewer({api, initial, photos, close, onMap}: {api: BrowseApi; initial: Photo; photos: Photo[]; close: () => void; onMap: (focus: MapFocus) => void}) {
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(Math.max(0, photos.findIndex(p => p.id === initial.id)));
  const selected = photos[index] ?? initial;
  const selectedID = useRef(selected.id);
  selectedID.current = selected.id;
  const [photo, setPhoto] = useState(selected);
  const [folderName, setFolderName] = useState('');
  const [canManage, setCanManage] = useState(false);
  const [managing, setManaging] = useState(false);
  const [details, setDetails] = useState(false);
  const revision = useSyncExternalStore(api.subscribe, api.getRevision);
  const [source, setSource] = useState<{uri: string; headers: {Authorization: string}}>();
  const [motionSource, setMotionSource] = useState<{uri: string; headers: {Authorization: string}}>();
  const [motionState, setMotionState] = useState<'none' | 'loading' | 'playing' | 'failed'>('none');
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [state, setState] = useState<LoadState>('loading');
  // The grid already fetched this thumbnail; it stands in until the preview decodes.
  const [placeholder, setPlaceholder] = useState<MediaSource>();
  const [previewShown, setPreviewShown] = useState(false);
  const [detailReady, setDetailReady] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [sharing, setSharing] = useState(false);
  const pendingFavorites = useRef(new Set<string>());
  const favoriteOverrides = useRef(new Map<string, boolean>());
  const [favoritePendingIDs, setFavoritePendingIDs] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState('');
  const [mediaRetry, setMediaRetry] = useState(0);
  const [motionRetry, setMotionRetry] = useState(0);
  const [zoom, setZoom] = useState(1);
  const touch = useRef({x: 0, time: 0, distance: 0, zoom: 1});
  const lastTap = useRef(0);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => setForeground(next === 'active'));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    let active = true;
    setDetails(false);
    setPhoto({...selected, is_favorite: favoriteOverrides.current.get(selected.id) ?? selected.is_favorite}); setFolderName(''); setCanManage(false); setZoom(1); setState('loading'); setSource(undefined);
    setMotionSource(undefined); setMotionState('none'); setNotice(''); setDetailReady(false); setPreviewShown(false);
    setPlaceholder(selected.mime_type.startsWith('video/') ? undefined : api.peekMediaSource(selected.id, 'thumbnail'));
    let failed = false;
    const fail = (error: unknown) => {if (active && !failed) {failed = true; setState(errorState(error));}};
    // The preview starts loading at once; metadata follows without holding it back.
    api.mediaSource(selected.id, 'preview').then(preview => {if (active && !failed) {setSource(preview); setState('ready');}}).catch(fail);
    Promise.all([api.photo(selected.id), api.liveStatus([selected.id]).catch(() => selected.is_live_photo ? [selected.id] : [])]).then(([detail, liveIds]) => {
      if (!active || failed) {return;}
      const isLive = liveIds.includes(selected.id);
      setPhoto({...detail, is_favorite: favoriteOverrides.current.get(selected.id) ?? detail.is_favorite, is_live_photo: isLive}); setDetailReady(true);
      api.writableFolder(detail.folder_id).then(folder => {if (active) {setFolderName(folder.name); setCanManage(folder.effective_permission === 'write');}}).catch(() => {});
      if (isLive) {
        setMotionState('loading');
        api.mediaSource(selected.id, 'motion').then(value => {if (active) {setMotionSource(value);}})
          .catch(() => {if (active) {setMotionState('failed');}});
      }
    }).catch(fail);
    return () => {active = false;};
  }, [api, selected, mediaRetry, motionRetry, revision]);
  async function mediaFailed() {
    if (mediaRetry < 1) {
      try {await api.retryMedia(); setMediaRetry(value => value + 1); return;} catch (error) {setState(errorState(error));}
    } else {setState('failed');}
  }
  async function download() {
    if (downloading) {return;}
    setDownloading(true); setNotice('');
    try {
      const file = await api.mediaSource(photo.id, 'original');
      const safeName = photo.filename.replace(/[\\/:*?"<>|]/g, '_');
      const result = await ReactNativeBlobUtil.config({addAndroidDownloads: {
        useDownloadManager: true, notification: true, title: photo.filename,
        description: '77Photo 原图下载', mime: photo.mime_type, mediaScannable: true,
        path: `${ReactNativeBlobUtil.fs.dirs.DownloadDir}/77Photo-${Date.now()}-${safeName}`,
      }}).fetch('GET', file.uri, file.headers);
      if (result.info().status >= 400) {throw new Error(`下载失败：HTTP ${result.info().status}`);}
      setNotice('已保存到下载目录');
    } catch (error) {setNotice(error instanceof Error ? error.message : '下载失败');}
    finally {setDownloading(false);}
  }
  async function share() {
    if (sharing) {return;}
    setSharing(true); setNotice('');
    try {
      const file = await api.mediaSource(photo.id, 'original');
      await NativeModules.Photo77Picker.shareMedia(file.uri, file.headers.Authorization, photo.mime_type, photo.filename);
    } catch (error) {setNotice(error instanceof Error ? error.message : '分享失败，请重试');}
    finally {setSharing(false);}
  }
  async function toggleFavorite() {
    if (typeof photo.is_favorite !== 'boolean' || pendingFavorites.current.has(photo.id)) {return;}
    const targetID = photo.id;
    const previous = photo.is_favorite;
    const priorOverride = favoriteOverrides.current.get(targetID);
    favoriteOverrides.current.set(targetID, !previous);
    setPhoto(current => current.id === targetID ? {...current, is_favorite: !previous} : current);
    pendingFavorites.current.add(targetID);
    setFavoritePendingIDs(new Set(pendingFavorites.current));
    setNotice('');
    try {await api.setFavorite(targetID, !previous); api.photoFavorited(targetID, !previous);}
    catch (error) {
      if (priorOverride === undefined) {favoriteOverrides.current.delete(targetID);}
      else {favoriteOverrides.current.set(targetID, priorOverride);}
      setPhoto(current => current.id === targetID ? {...current, is_favorite: previous} : current);
      if (selectedID.current === targetID) {setNotice(error instanceof Error ? error.message : '收藏操作失败，请重试');}
    } finally {
      pendingFavorites.current.delete(targetID);
      setFavoritePendingIDs(new Set(pendingFavorites.current));
    }
  }
  const video = photo.mime_type.startsWith('video/');
  function beginTouch(points: readonly {pageX: number; pageY: number}[]) {
    touch.current.x = points[0]?.pageX ?? 0;
    touch.current.time = Date.now();
    touch.current.zoom = zoom;
    touch.current.distance = points.length > 1 ? Math.hypot(points[0].pageX - points[1].pageX, points[0].pageY - points[1].pageY) : 0;
  }
  function moveTouch(points: readonly {pageX: number; pageY: number}[]) {
    if (video || points.length < 2 || !touch.current.distance) {return;}
    const distance = Math.hypot(points[0].pageX - points[1].pageX, points[0].pageY - points[1].pageY);
    setZoom(Math.max(1, Math.min(4, touch.current.zoom * distance / touch.current.distance)));
  }
  function endTouch(x: number) {
    const now = Date.now();
    if (zoom === 1 && Math.abs(x - touch.current.x) > 65 && now - touch.current.time < 600) {
      if (x < touch.current.x && index < photos.length - 1) {setIndex(index + 1);}
      if (x > touch.current.x && index > 0) {setIndex(index - 1);}
    } else if (!video && now - lastTap.current < 300) {setZoom(zoom > 1 ? 1 : 2);}
    lastTap.current = now;
  }
  return <View style={styles.viewer}>
    <StatusBar barStyle="light-content" />
    <View style={styles.viewerTop}>
      <Pressable style={styles.viewerButton} accessibilityRole="button" accessibilityLabel="返回浏览" onPress={close}><Icon name="back" tone="light" size={24} /></Pressable>
      <Text style={styles.viewerCount}>{index + 1} / {photos.length}</Text>
      <View style={styles.viewerActions}>
        {typeof photo.is_favorite === 'boolean' ? <Pressable style={styles.viewerButton} accessibilityRole="button" accessibilityLabel={photo.is_favorite ? '取消收藏' : '加入收藏'} accessibilityState={{selected: photo.is_favorite, busy: favoritePendingIDs.has(photo.id)}} disabled={favoritePendingIDs.has(photo.id)} onPress={toggleFavorite}>{favoritePendingIDs.has(photo.id) ? <ActivityIndicator color="#FFF" /> : <Text style={styles.favoriteIcon}>{photo.is_favorite ? '♥' : '♡'}</Text>}</Pressable> : null}
        <Pressable style={styles.viewerButton} accessibilityRole="button" accessibilityLabel="分享原文件" disabled={sharing} onPress={share}>{sharing ? <ActivityIndicator color="#FFF" /> : <Icon name="share" tone="light" size={23} />}</Pressable>
        <Pressable style={styles.viewerButton} accessibilityRole="button" accessibilityLabel="下载原文件" disabled={downloading} onPress={download}>{downloading ? <ActivityIndicator color="#FFF" /> : <Icon name="download" tone="light" size={23} />}</Pressable>
      </View>
    </View>
    <View style={styles.viewerMedia} onTouchStart={event => beginTouch(event.nativeEvent.touches)}
      onTouchMove={event => moveTouch(event.nativeEvent.touches)} onTouchEnd={event => endTouch(event.nativeEvent.changedTouches[0]?.pageX ?? touch.current.x)}>
      {placeholder && !previewShown && (state === 'loading' || state === 'ready') ? <Image source={placeholder} style={styles.motionMedia} resizeMode="contain" onError={() => setPlaceholder(undefined)} /> : null}
      {state === 'ready' && source ? video ? <Video source={source} style={styles.fullMedia} controls paused={!foreground} resizeMode="contain" onError={mediaFailed} /> :
        <Image source={source} style={[styles.fullMedia, {transform: [{scale: zoom}]}]} resizeMode="contain" onLoad={() => setPreviewShown(true)} onError={mediaFailed} /> :
        state === 'loading' && placeholder ? null : <StateView state={state} retry={() => setMediaRetry(value => value + 1)} />}
      {placeholder && !previewShown && (state === 'loading' || state === 'ready') ? <ActivityIndicator style={styles.previewSpinner} color="#FFF" /> : null}
      {state === 'ready' && !video && motionSource && foreground && motionState !== 'failed' ?
        <Video key={`${photo.id}-${motionRetry}`} source={motionSource} style={styles.motionMedia} controls={false} paused={!foreground} repeat resizeMode="contain"
          onLoad={() => setMotionState('playing')} onError={() => {setMotionSource(undefined); setMotionState('failed');}} /> : null}
      {photo.is_live_photo && state === 'ready' ? <View style={styles.liveBadge}><Text style={styles.liveBadgeText}>LIVE{motionState === 'loading' ? ' · 加载中' : motionState === 'failed' ? ' · 动态片段不可用' : ''}</Text></View> : null}
      {motionState === 'failed' ? <Pressable accessibilityRole="button" accessibilityLabel="重试播放动态片段" style={styles.motionRetry} onPress={() => setMotionRetry(value => value + 1)}><Text style={styles.motionRetryText}>重试动态片段</Text></Pressable> : null}
    </View>
    <View style={[styles.viewerSheet, {paddingBottom: Math.max(insets.bottom, 12)}]}>
      <View style={ui.row}><Action label="照片详情" disabled={state !== 'ready' || !detailReady} onPress={() => setDetails(true)} />{canManage ? <Action label="管理照片 · 移动 / 删除" onPress={() => setManaging(true)} /> : null}</View>
      <View style={styles.viewerNav}>
        <Pressable disabled={index === 0} accessibilityRole="button" accessibilityLabel="上一项" accessibilityState={{disabled: index === 0}} style={styles.navButton} onPress={() => setIndex(index - 1)}><Icon name="back" tone={index === 0 ? 'muted' : 'ink'} size={22} /></Pressable>
        <View style={styles.viewerIdentity}><Text style={styles.viewerName} numberOfLines={1}>{photo.filename}</Text><Text style={styles.viewerMeta} numberOfLines={1}>{photo.captured_at.replace('T', ' ').slice(0, 16)}{folderName ? ` · ${folderName}` : ''} · {(photo.size / 1024 / 1024).toFixed(1)} MB</Text></View>
        <Pressable disabled={index >= photos.length - 1} accessibilityRole="button" accessibilityLabel="下一项" accessibilityState={{disabled: index >= photos.length - 1}} style={styles.navButton} onPress={() => setIndex(index + 1)}><Icon name="next" tone={index >= photos.length - 1 ? 'muted' : 'ink'} size={22} /></Pressable>
      </View>
      {notice ? <Text accessibilityRole="alert" style={styles.viewerNotice}>{notice}</Text> : null}
    </View>
    {details ? <PhotoDetails api={api} photo={photo} folderName={folderName} close={() => setDetails(false)} onMap={onMap} /> : null}
    {managing ? <Sheet title="管理照片" close={() => setManaging(false)}>
      <PhotoActions api={api} photos={[photo]} completed={ids => {if (ids.includes(photo.id)) {close();}}} close={() => setManaging(false)} />
    </Sheet> : null}
  </View>;
}

// Keeps a tab mounted while another is in front, so its scroll position and
// loaded pages survive a round trip.
function Pane({active, children}: {active: boolean; children: React.ReactNode}) {
  return <View style={[styles.content, !active && styles.hidden]} accessibilityElementsHidden={!active} importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}>{children}</View>;
}

export default function BrowseApp({session, onSession, onSignOut, onExpired, error}: {session: MobileSession; onSession: (session: MobileSession) => void; onSignOut: () => void; onExpired?: () => void; error: string}) {
  const [api] = useState(() => new BrowseApi(session, onSession));
  const [connectionNotice, setConnectionNotice] = useState('');
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reconnect = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        api.reconnect(true).then(() => {if (active) {setConnectionNotice('');}})
          .catch(problem => {if (active) {setConnectionNotice(problem instanceof Error ? problem.message : '无法连接服务器');}});
      }, 500);
    };
    const foreground = AppState.addEventListener('change', state => {if (state === 'active') {reconnect();}});
    let networkSignature: string | undefined;
    const network = NetInfo.addEventListener(state => {
      const signature = JSON.stringify([state.type, state.isConnected, state.details && 'ipAddress' in state.details ? state.details.ipAddress : null]);
      if (signature !== networkSignature) {networkSignature = signature; reconnect();}
    });
    const connected = api.subscribe(() => {if (active) {setConnectionNotice('');}});
    return () => {active = false; clearTimeout(timer); foreground.remove(); network(); connected();};
  }, [api]);
  const [tab, setTab] = useState<'photos' | 'folders' | 'backup'>('photos');
  const [stack, setStack] = useState<Folder[]>([]);
  const [uploadFolder, setUploadFolder] = useState<Folder | null>(null);
  const [viewer, setViewer] = useState<{photo: Photo; photos: Photo[]} | null>(null);
  const [settings, setSettings] = useState(false);
  const [trash, setTrash] = useState(false);
  const [workspace, setWorkspace] = useState<'map' | 'people' | null>(null);
  const [mapFocus, setMapFocus] = useState<MapFocus>();
  const [admin, setAdmin] = useState(false);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  const revision = useSyncExternalStore(api.subscribe, api.getRevision);
  useEffect(() => {
    let active = true;
    api.me().then(me => {if (active) {setAdmin(me.role === 'admin');}}).catch(problem => {
      if (!active) {return;}
      setAdmin(false);
      // The server rejected this device even after a token refresh.
      if (problem instanceof ApiError && problem.status === 401) {expired.current?.();}
    });
    return () => {active = false;};
  }, [api, revision]);
  // Folders load on first visit, then stay mounted like the photo timeline.
  const [foldersOpened, setFoldersOpened] = useState(false);
  if (tab === 'folders' && !foldersOpened) {setFoldersOpened(true);}
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (viewer) {setViewer(null); return true;}
      if (settings) {setSettings(false); return true;}
      if (trash) {setTrash(false); return true;}
      if (workspace) {return false;}
      if (tab === 'folders' && stack.length) {setStack(stack.slice(0, -1)); return true;}
      if (tab !== 'photos') {setTab('photos'); return true;}
      return false;
    });
    return () => subscription.remove();
  }, [api, viewer, settings, trash, workspace, tab, stack]);
  const open = (photo: Photo, photos: Photo[]) => setViewer({photo, photos});
  return <SafeAreaView style={[styles.root, viewer && styles.viewerRoot]} edges={viewer ? ['top'] : ['top', 'bottom']}>
    <StatusBar barStyle="dark-content" />
    {connectionNotice ? <Text accessibilityRole="alert" style={styles.error}>{connectionNotice}</Text> : null}
    {trash ? <TrashPage api={api} close={() => setTrash(false)} /> : viewer ? <Viewer api={api} initial={viewer.photo} photos={viewer.photos} close={() => setViewer(null)} onMap={focus => {setMapFocus(focus); setWorkspace('map'); setViewer(null);}} /> : settings ?
      <ScrollView style={styles.content} contentContainerStyle={styles.settingsContent} keyboardShouldPersistTaps="handled">
        <View style={styles.settingsHeader}><Text style={styles.settingsTitle}>设置</Text><Pressable accessibilityRole="button" accessibilityLabel="返回" style={styles.settingsBack} onPress={() => setSettings(false)}><Icon name="back" size={22} /><Text style={styles.backLabel}>返回</Text></Pressable></View>
        <Text style={styles.settingsUsername}>{session.username}</Text>
        <ServerAddresses api={api} session={session} />
        <UpdateSettings />
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <Pressable accessibilityRole="button" style={styles.retry} onPress={onSignOut}><Text style={styles.retryText}>退出当前设备</Text></Pressable></ScrollView> : null}
    <View style={[styles.content, (settings || !!viewer || trash) && styles.hidden]} accessibilityElementsHidden={settings || !!viewer || trash} importantForAccessibility={settings || viewer || trash ? 'no-hide-descendants' : 'auto'}>
      <View style={styles.content}>{workspace === 'map' ? <MapPage api={api} close={() => setWorkspace(null)} open={open} focus={mapFocus} /> : workspace === 'people' ? <PeoplePage api={api} close={() => setWorkspace(null)} open={open} /> : null}
        <Pane active={!workspace && tab === 'photos'}><Photos api={api} active={!workspace && tab === 'photos'} open={open} settings={() => setSettings(true)} trash={() => setTrash(true)} map={() => {setMapFocus(undefined); setWorkspace('map');}} people={admin ? () => setWorkspace('people') : undefined} /></Pane>
        {foldersOpened ? <Pane active={!workspace && tab === 'folders'}><Folders api={api} active={!workspace && tab === 'folders'} stack={stack} setStack={setStack} open={open} settings={() => setSettings(true)} upload={folder => {setUploadFolder(folder); setTab('backup');}} /></Pane> : null}
        <UploadPage api={api} session={session} active={tab === 'backup' && !settings && !viewer && !trash && !workspace} incomingFolder={uploadFolder} clearIncoming={() => setUploadFolder(null)} /></View>
      {!workspace ? <View style={styles.tabs}>{(['photos', 'folders', 'backup'] as const).map(item => {
        const label = {photos: '照片', folders: '文件夹', backup: '备份'}[item];
        const active = tab === item;
        return <Pressable key={item} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{selected: active}} style={[styles.tab, active && styles.tabSelected]} onPress={() => setTab(item)}>
          <Icon name={item} tone={active ? 'ink' : 'muted'} size={23} /><Text style={[styles.tabText, active && styles.tabActive]}>{label}</Text>
        </Pressable>;
      })}</View> : null}
    </View>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: paper}, viewerRoot: {backgroundColor: '#161B22'}, content: {flex: 1}, hidden: {display: 'none'}, page: {flex: 1, paddingTop: 14},
  title: {fontSize: 26, color: ink, fontWeight: '700', marginHorizontal: 20, marginBottom: 14},
  settingsContent: {paddingTop: 14, paddingBottom: 32}, settingsHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14},
  settingsTitle: {fontSize: 26, color: ink, fontWeight: '700', marginLeft: 20}, settingsBack: {minHeight: 48, flexDirection: 'row', alignItems: 'center', marginRight: 12}, settingsUsername: {color: muted, fontSize: 13, marginHorizontal: 20, marginTop: 5},
  headingRow: {flexDirection: 'row', alignItems: 'center'}, back: {minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center'}, backText: {color: ink, fontSize: 30}, backLabel: {color: ink, fontSize: 15, marginRight: 12},
  folderHeading: {flex: 1, minWidth: 0, fontSize: 26, color: ink, fontWeight: '700', marginLeft: 20, marginRight: 8}, headingActions: {flexDirection: 'row', alignItems: 'center', marginRight: 12}, headerAction: {width: 48, height: 48, alignItems: 'center', justifyContent: 'center'}, moreSpinner: {marginVertical: 20},
  topRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'}, settingsButton: {minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginRight: 12}, settingsText: {fontSize: 23, color: ink},
  list: {paddingBottom: 28}, date: {fontSize: 18, fontWeight: '600', color: ink, marginHorizontal: 16, marginTop: 20, marginBottom: 12},
  selectionBadge: {position: 'absolute', left: 5, top: 5, backgroundColor: '#FFF', color: '#3D4A5C', fontWeight: '700', fontSize: 18, borderRadius: 14, width: 28, height: 28, textAlign: 'center', lineHeight: 28}, selectionChecked: {backgroundColor: '#3D4A5C', color: '#FFF'},
  grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 2, marginHorizontal: 16}, tile: {backgroundColor: '#ECE9E5', alignItems: 'center', justifyContent: 'center'}, tileImage: {width: '100%', height: '100%'}, tileFallback: {color: muted, fontSize: 12},
  badge: {position: 'absolute', right: 5, bottom: 5, backgroundColor: '#263543CC', color: '#FFF', fontSize: 11, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 5, overflow: 'hidden'}, badgeRow: {position: 'absolute', right: 5, bottom: 5, backgroundColor: '#263543CC', borderRadius: 6, paddingHorizontal: 5, paddingVertical: 3, flexDirection: 'row', alignItems: 'center'}, badgeLabel: {color: '#FFF', fontSize: 11, marginLeft: 2},
  state: {minHeight: 130, alignItems: 'center', justifyContent: 'center', padding: 20}, stateText: {fontSize: 15, color: muted, textAlign: 'center', marginTop: 10},
  retry: {minHeight: 48, alignSelf: 'center', justifyContent: 'center', paddingHorizontal: 22, backgroundColor: '#E8D4B8', borderRadius: 16, marginTop: 12}, retryText: {color: ink, fontWeight: '600'},
  path: {color: muted, fontSize: 13, marginHorizontal: 20, marginBottom: 12}, folder: {minHeight: 76, flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 12, backgroundColor: '#FFF', borderColor: border, borderWidth: 1, borderRadius: 18},
  folderIcon: {width: 46, height: 46, backgroundColor: '#E7F0EB', borderRadius: 14, alignItems: 'center', justifyContent: 'center'}, folderIconText: {color: '#779B88', fontSize: 23}, folderCopy: {flex: 1, marginLeft: 12}, folderName: {color: ink, fontSize: 16, fontWeight: '600'}, meta: {color: muted, fontSize: 13, marginTop: 5}, chevron: {color: muted, fontSize: 25}, section: {fontSize: 18, color: ink, fontWeight: '600', marginHorizontal: 20, marginTop: 24, marginBottom: 12},
  folderImage: {width: 46, height: 46, borderRadius: 14},
  tabs: {height: 66, flexDirection: 'row', borderTopWidth: 1, borderColor: border, backgroundColor: '#FFF', paddingHorizontal: 8, paddingTop: 4}, tab: {flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center', gap: 3, borderRadius: 14}, tabSelected: {backgroundColor: '#F2F3F2'}, tabText: {fontSize: 12, color: muted}, tabActive: {color: ink, fontWeight: '700'},
  error: {color: '#A65757', fontSize: 14, margin: 16},
  viewer: {flex: 1, backgroundColor: '#161B22'}, viewerTop: {height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8}, viewerActions: {flexDirection: 'row'}, viewerButton: {width: 52, height: 52, justifyContent: 'center', alignItems: 'center'}, viewerCount: {color: '#FFFFFF', fontSize: 13, fontWeight: '600'}, viewerMedia: {flex: 1, justifyContent: 'center', overflow: 'hidden'}, fullMedia: {width: '100%', height: '100%'}, motionMedia: {position: 'absolute', width: '100%', height: '100%', top: 0, left: 0}, previewSpinner: {position: 'absolute', right: 16, bottom: 16},
  favoriteIcon: {color: '#FFFFFF', fontSize: 26},
  liveBadge: {position: 'absolute', top: 12, left: 16, backgroundColor: '#161B22BB', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5}, liveBadgeText: {color: '#FFFFFF', fontSize: 11, fontWeight: '600'}, motionRetry: {position: 'absolute', bottom: 18, alignSelf: 'center', minHeight: 48, justifyContent: 'center', paddingHorizontal: 18, borderRadius: 16, backgroundColor: '#FFFFFFE8'}, motionRetryText: {color: ink, fontSize: 13, fontWeight: '600'},
  viewerSheet: {backgroundColor: paper, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingTop: 8, paddingHorizontal: 10}, viewerNav: {flexDirection: 'row', alignItems: 'center', minHeight: 64}, navButton: {minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center'}, viewerIdentity: {flex: 1, alignItems: 'center', paddingHorizontal: 4}, viewerName: {fontSize: 15, fontWeight: '600', color: ink, textAlign: 'center'}, viewerMeta: {fontSize: 12, color: muted, marginTop: 4}, viewerNotice: {fontSize: 13, color: ink, textAlign: 'center', marginBottom: 8},
});
