import NetInfo from '@react-native-community/netinfo';
import ServerAddresses from '../auth/ServerAddresses';
import React, {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {ActivityIndicator, AppState, BackHandler, FlatList, Image, NativeModules, Pressable, ScrollView, StatusBar, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import Video from 'react-native-video';
import ReactNativeBlobUtil from 'react-native-blob-util';
import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
import type {MobileSession} from '../auth/session';
import {BrowseApi, errorState, groupPhotos, type Folder, type LoadState, type Photo} from './api';
import {usePhotos} from './usePhotos';
import UploadPage from '../upload/UploadPage';
import Icon from './Icon';

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

function MediaTile({api, photo, size, open}: {api: BrowseApi; photo: Photo; size: number; open: () => void}) {
  const revision = useSyncExternalStore(api.subscribe, api.getRevision);
  const [source, setSource] = useState<{uri: string; headers: {Authorization: string}}>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setFailed(false);
    api.mediaSource(photo.id, 'thumbnail').then(value => {if (live) {setSource(value);}}).catch(() => {if (live) {setFailed(true);}});
    return () => {live = false;};
  }, [api, photo.id, attempt, revision]);
  function imageError() {
    if (attempt < 2) {api.reconnect().then(() => {setFailed(false); setAttempt(attempt + 1);}).catch(() => setFailed(true));}
    else {setFailed(true);}
  }
  return <Pressable style={[styles.tile, {width: size, height: size}]} accessibilityRole="button"
    accessibilityLabel={`${photo.is_live_photo ? '动态照片' : photo.mime_type.startsWith('video/') ? '视频' : '照片'}，${photo.filename}`}
    onPress={open}>
    {source && !failed ? <Image source={source} style={styles.tileImage} onError={imageError} resizeMode="cover" /> :
      <Text style={styles.tileFallback}>{failed ? '预览失败' : ''}</Text>}
    {photo.is_live_photo ? <Text style={styles.badge}>LIVE</Text> : photo.mime_type.startsWith('video/') ? <View style={styles.badgeRow}><Icon name="video" tone="light" size={15} /><Text style={styles.badgeLabel}>视频</Text></View> : null}
  </Pressable>;
}

function MediaGrid({api, photos, open}: {api: BrowseApi; photos: Photo[]; open: (photo: Photo, all: Photo[]) => void}) {
  const {width} = useWindowDimensions();
  const size = Math.floor((width - 36) / 3);
  return <View style={styles.grid}>{photos.map(photo => <MediaTile key={photo.id} api={api} photo={photo} size={size} open={() => open(photo, photos)} />)}</View>;
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

function Photos({api, open, settings}: {api: BrowseApi; open: (photo: Photo, all: Photo[]) => void; settings: () => void}) {
  const page = usePhotos(api);
  const timeline = useMemo(() => groupPhotos(page.items).flatMap(group => {
    const rows: ({type: 'date'; key: string; date: string} | {type: 'row'; key: string; photos: Photo[]})[] =
      [{type: 'date', key: group.date, date: group.date}];
    for (let offset = 0; offset < group.items.length; offset += 3) {
      rows.push({type: 'row', key: group.items[offset].id, photos: group.items.slice(offset, offset + 3)});
    }
    return rows;
  }), [page.items]);
  return <View style={styles.page}>
    <View style={styles.topRow}><Text style={styles.title}>77Photo</Text><Pressable style={styles.settingsButton} accessibilityRole="button" accessibilityLabel="设置" onPress={settings}><Icon name="settings" size={22} /></Pressable></View>
    {page.state !== 'ready' ? <StateView state={page.state} retry={page.refresh} /> :
      <FlatList data={timeline} keyExtractor={item => item.key} onEndReached={() => {if (page.cursor && page.moreState === 'ready') {page.loadMore();}}}
        onEndReachedThreshold={0.4} windowSize={7} initialNumToRender={8} refreshing={false} onRefresh={() => {page.refresh();}}
        renderItem={({item}) => item.type === 'date' ? <Text style={styles.date}>{item.date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_, y, m, d) => `${y}年${Number(m)}月${Number(d)}日`)}</Text> :
          <MediaGrid api={api} photos={item.photos} open={photo => open(photo, page.items)} />}
        ListFooterComponent={page.moreState === 'loading' ? <ActivityIndicator color={ink} /> : page.moreState !== 'ready' ? <StateView state={page.moreState} retry={page.loadMore} /> : undefined}
        contentContainerStyle={styles.list} />}
  </View>;
}

function Folders({api, stack, setStack, open, settings, upload}: {api: BrowseApi; stack: Folder[]; setStack: (folders: Folder[]) => void; open: (photo: Photo, all: Photo[]) => void; settings: () => void; upload: (folder: Folder) => void}) {
  const revision = useSyncExternalStore(api.subscribe, api.getRevision);
  const current = stack[stack.length - 1];
  const viewportHeight = useRef(0);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const page = usePhotos(api, current?.id);
  const load = useCallback(async () => {
    setState('loading');
    try {const result = await api.listFolders(current?.id); setFolders(result); setState(result.length ? 'ready' : 'empty');}
    catch (error) {setState(errorState(error));}
  }, [api, current?.id]);
  useEffect(() => {load();}, [load, revision]);
  const loadNearEnd = (remaining: number) => {
    if (current && remaining < 320 && page.cursor && page.moreState === 'ready') {page.loadMore();}
  };
  return <View style={styles.page}>
    <View style={styles.headingRow}>{current ? <Pressable accessibilityRole="button" accessibilityLabel="返回上级文件夹" style={styles.back} onPress={() => setStack(stack.slice(0, -1))}><Icon name="back" size={24} /></Pressable> : null}
      <Text style={styles.folderHeading} numberOfLines={1}>{current?.name ?? '文件夹'}</Text><View style={styles.headingActions}>{current?.effective_permission === 'write' ? <Pressable style={styles.headerAction} accessibilityRole="button" accessibilityLabel={`上传到 ${current.name}`} onPress={() => upload(current)}><Icon name="plus" size={22} /></Pressable> : null}<Pressable style={styles.headerAction} accessibilityRole="button" accessibilityLabel="设置" onPress={settings}><Icon name="settings" size={22} /></Pressable></View></View>
    <ScrollView contentContainerStyle={styles.list} scrollEventThrottle={120}
      onLayout={event => {viewportHeight.current = event.nativeEvent.layout.height;}}
      onContentSizeChange={(_width, height) => loadNearEnd(height - viewportHeight.current)}
      onScroll={event => {const {contentOffset, contentSize, layoutMeasurement} = event.nativeEvent; loadNearEnd(contentSize.height - layoutMeasurement.height - contentOffset.y);}}>
      {stack.length ? <Text style={styles.path}>{stack[0].is_shared ? '共享文件夹' : '我的文件夹'} / {stack.map(f => f.name).join(' / ')}</Text> : null}
      {state === 'ready' ? folders.map(folder => <Pressable key={folder.id} accessibilityRole="button" accessibilityLabel={`进入文件夹 ${folder.name}`} style={styles.folder} onPress={() => setStack([...stack, folder])}>
        <FolderCover api={api} folder={folder} /><View style={styles.folderCopy}>
          <Text style={styles.folderName}>{folder.name}</Text><Text style={styles.meta}>{folder.photo_count ?? 0} 个媒体 · {folder.child_folder_count ?? 0} 个子文件夹{folder.is_shared ? ' · 共享' : ''}</Text>
          <Text style={styles.meta}>{folder.effective_permission === 'write' ? '可编辑' : '只读'}</Text></View><Icon name="next" tone="muted" size={20} />
        </Pressable>) : state !== 'empty' ? <StateView state={state} retry={load} /> : null}
      {current ? <>
        <Text style={styles.section}>此目录及子目录媒体</Text>
        {page.state === 'ready' ? <><MediaGrid api={api} photos={page.items} open={open} />
          {page.moreState === 'loading' ? <ActivityIndicator style={styles.moreSpinner} color={ink} /> : page.moreState !== 'ready' ? <StateView state={page.moreState} retry={page.loadMore} /> : null}</> : <StateView state={page.state} retry={page.refresh} />}
      </> : state === 'empty' ? <StateView state="empty" retry={load} /> : null}
    </ScrollView>
  </View>;
}

function Viewer({api, initial, photos, close}: {api: BrowseApi; initial: Photo; photos: Photo[]; close: () => void}) {
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(Math.max(0, photos.findIndex(p => p.id === initial.id)));
  const selected = photos[index] ?? initial;
  const [photo, setPhoto] = useState(selected);
  const [folderName, setFolderName] = useState('');
  const revision = useSyncExternalStore(api.subscribe, api.getRevision);
  const [source, setSource] = useState<{uri: string; headers: {Authorization: string}}>();
  const [motionSource, setMotionSource] = useState<{uri: string; headers: {Authorization: string}}>();
  const [motionState, setMotionState] = useState<'none' | 'loading' | 'playing' | 'failed'>('none');
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [state, setState] = useState<LoadState>('loading');
  const [downloading, setDownloading] = useState(false);
  const [sharing, setSharing] = useState(false);
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
    setPhoto(selected); setFolderName(''); setZoom(1); setState('loading'); setSource(undefined);
    setMotionSource(undefined); setMotionState('none'); setNotice('');
    Promise.all([api.photo(selected.id), api.mediaSource(selected.id, 'preview'), api.liveStatus([selected.id]).catch(() => selected.is_live_photo ? [selected.id] : [])]).then(([detail, preview, liveIds]) => {
      if (!active) {return;}
      const isLive = liveIds.includes(selected.id);
      setPhoto({...detail, is_live_photo: isLive}); setSource(preview); setState('ready');
      api.folder(detail.folder_id).then(folder => {if (active) {setFolderName(folder.name);}}).catch(() => {});
      if (isLive) {
        setMotionState('loading');
        api.mediaSource(selected.id, 'motion').then(value => {if (active) {setMotionSource(value);}})
          .catch(() => {if (active) {setMotionState('failed');}});
      }
    }).catch(error => {if (active) {setState(errorState(error));}});
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
        <Pressable style={styles.viewerButton} accessibilityRole="button" accessibilityLabel="分享原文件" disabled={sharing} onPress={share}>{sharing ? <ActivityIndicator color="#FFF" /> : <Icon name="share" tone="light" size={23} />}</Pressable>
        <Pressable style={styles.viewerButton} accessibilityRole="button" accessibilityLabel="下载原文件" disabled={downloading} onPress={download}>{downloading ? <ActivityIndicator color="#FFF" /> : <Icon name="download" tone="light" size={23} />}</Pressable>
      </View>
    </View>
    <View style={styles.viewerMedia} onTouchStart={event => beginTouch(event.nativeEvent.touches)}
      onTouchMove={event => moveTouch(event.nativeEvent.touches)} onTouchEnd={event => endTouch(event.nativeEvent.changedTouches[0]?.pageX ?? touch.current.x)}>
      {state === 'ready' && source ? video ? <Video source={source} style={styles.fullMedia} controls paused={!foreground} resizeMode="contain" onError={mediaFailed} /> :
        <Image source={source} style={[styles.fullMedia, {transform: [{scale: zoom}]}]} resizeMode="contain" onError={mediaFailed} /> : <StateView state={state} retry={() => setMediaRetry(value => value + 1)} />}
      {state === 'ready' && !video && motionSource && foreground && motionState !== 'failed' ?
        <Video key={`${photo.id}-${motionRetry}`} source={motionSource} style={styles.motionMedia} controls={false} paused={!foreground} repeat resizeMode="contain"
          onLoad={() => setMotionState('playing')} onError={() => {setMotionSource(undefined); setMotionState('failed');}} /> : null}
      {photo.is_live_photo && state === 'ready' ? <View style={styles.liveBadge}><Text style={styles.liveBadgeText}>LIVE{motionState === 'loading' ? ' · 加载中' : motionState === 'failed' ? ' · 动态片段不可用' : ''}</Text></View> : null}
      {motionState === 'failed' ? <Pressable accessibilityRole="button" accessibilityLabel="重试播放动态片段" style={styles.motionRetry} onPress={() => setMotionRetry(value => value + 1)}><Text style={styles.motionRetryText}>重试动态片段</Text></Pressable> : null}
    </View>
    <View style={[styles.viewerSheet, {paddingBottom: Math.max(insets.bottom, 12)}]}>
      <View style={styles.viewerNav}>
        <Pressable disabled={index === 0} accessibilityRole="button" accessibilityLabel="上一项" accessibilityState={{disabled: index === 0}} style={styles.navButton} onPress={() => setIndex(index - 1)}><Icon name="back" tone={index === 0 ? 'muted' : 'ink'} size={22} /></Pressable>
        <View style={styles.viewerIdentity}><Text style={styles.viewerName} numberOfLines={1}>{photo.filename}</Text><Text style={styles.viewerMeta} numberOfLines={1}>{photo.captured_at.replace('T', ' ').slice(0, 16)}{folderName ? ` · ${folderName}` : ''} · {(photo.size / 1024 / 1024).toFixed(1)} MB</Text></View>
        <Pressable disabled={index >= photos.length - 1} accessibilityRole="button" accessibilityLabel="下一项" accessibilityState={{disabled: index >= photos.length - 1}} style={styles.navButton} onPress={() => setIndex(index + 1)}><Icon name="next" tone={index >= photos.length - 1 ? 'muted' : 'ink'} size={22} /></Pressable>
      </View>
      {notice ? <Text accessibilityRole="alert" style={styles.viewerNotice}>{notice}</Text> : null}
    </View>
  </View>;
}

export default function BrowseApp({session, onSession, onSignOut, error}: {session: MobileSession; onSession: (session: MobileSession) => void; onSignOut: () => void; error: string}) {
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
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (viewer) {setViewer(null); return true;}
      if (settings) {setSettings(false); return true;}
      if (tab === 'folders' && stack.length) {setStack(stack.slice(0, -1)); return true;}
      if (tab !== 'photos') {setTab('photos'); return true;}
      return false;
    });
    return () => subscription.remove();
  }, [viewer, settings, tab, stack]);
  const open = (photo: Photo, photos: Photo[]) => setViewer({photo, photos});
  return <SafeAreaView style={[styles.root, viewer && styles.viewerRoot]} edges={viewer ? ['top'] : ['top', 'bottom']}>
    <StatusBar barStyle="dark-content" />
    {connectionNotice ? <Text accessibilityRole="alert" style={styles.error}>{connectionNotice}</Text> : null}
    {viewer ? <Viewer api={api} initial={viewer.photo} photos={viewer.photos} close={() => setViewer(null)} /> : settings ?
      <ScrollView style={styles.page} keyboardShouldPersistTaps="handled"><Pressable accessibilityRole="button" style={styles.back} onPress={() => setSettings(false)}><Icon name="back" size={22} /><Text style={styles.backLabel}>返回</Text></Pressable>
        <Text style={styles.title}>设置</Text><Text style={styles.meta}>{session.username}</Text>
        <ServerAddresses api={api} session={session} />
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <Pressable accessibilityRole="button" style={styles.retry} onPress={onSignOut}><Text style={styles.retryText}>退出当前设备</Text></Pressable></ScrollView> : null}
    <View style={[styles.content, (settings || !!viewer) && styles.hidden]} accessibilityElementsHidden={settings || !!viewer} importantForAccessibility={settings || viewer ? 'no-hide-descendants' : 'auto'}>
      <View style={styles.content}>{tab === 'photos' ? <Photos api={api} open={open} settings={() => setSettings(true)} /> : tab === 'folders' ? <Folders api={api} stack={stack} setStack={setStack} open={open} settings={() => setSettings(true)} upload={folder => {setUploadFolder(folder); setTab('backup');}} /> : null}
        <UploadPage api={api} session={session} active={tab === 'backup' && !settings && !viewer} incomingFolder={uploadFolder} clearIncoming={() => setUploadFolder(null)} /></View>
      <View style={styles.tabs}>{(['photos', 'folders', 'backup'] as const).map(item => {
        const label = {photos: '照片', folders: '文件夹', backup: '备份'}[item];
        const active = tab === item;
        return <Pressable key={item} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{selected: active}} style={[styles.tab, active && styles.tabSelected]} onPress={() => setTab(item)}>
          <Icon name={item} tone={active ? 'ink' : 'muted'} size={23} /><Text style={[styles.tabText, active && styles.tabActive]}>{label}</Text>
        </Pressable>;
      })}</View>
    </View>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: paper}, viewerRoot: {backgroundColor: '#161B22'}, content: {flex: 1}, hidden: {display: 'none'}, page: {flex: 1, paddingTop: 14},
  title: {fontSize: 26, color: ink, fontWeight: '700', marginHorizontal: 20, marginBottom: 14},
  headingRow: {flexDirection: 'row', alignItems: 'center'}, back: {minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center'}, backText: {color: ink, fontSize: 30}, backLabel: {color: ink, fontSize: 15, marginRight: 12},
  folderHeading: {flex: 1, minWidth: 0, fontSize: 26, color: ink, fontWeight: '700', marginLeft: 20, marginRight: 8}, headingActions: {flexDirection: 'row', alignItems: 'center', marginRight: 12}, headerAction: {width: 48, height: 48, alignItems: 'center', justifyContent: 'center'}, moreSpinner: {marginVertical: 20},
  topRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'}, settingsButton: {minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginRight: 12}, settingsText: {fontSize: 23, color: ink},
  list: {paddingBottom: 28}, date: {fontSize: 18, fontWeight: '600', color: ink, marginHorizontal: 16, marginTop: 20, marginBottom: 12},
  grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 2, marginHorizontal: 16}, tile: {backgroundColor: '#ECE9E5', alignItems: 'center', justifyContent: 'center'}, tileImage: {width: '100%', height: '100%'}, tileFallback: {color: muted, fontSize: 12},
  badge: {position: 'absolute', right: 5, bottom: 5, backgroundColor: '#263543CC', color: '#FFF', fontSize: 11, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 5, overflow: 'hidden'}, badgeRow: {position: 'absolute', right: 5, bottom: 5, backgroundColor: '#263543CC', borderRadius: 6, paddingHorizontal: 5, paddingVertical: 3, flexDirection: 'row', alignItems: 'center'}, badgeLabel: {color: '#FFF', fontSize: 11, marginLeft: 2},
  state: {minHeight: 130, alignItems: 'center', justifyContent: 'center', padding: 20}, stateText: {fontSize: 15, color: muted, textAlign: 'center', marginTop: 10},
  retry: {minHeight: 48, alignSelf: 'center', justifyContent: 'center', paddingHorizontal: 22, backgroundColor: '#E8D4B8', borderRadius: 16, marginTop: 12}, retryText: {color: ink, fontWeight: '600'},
  path: {color: muted, fontSize: 13, marginHorizontal: 20, marginBottom: 12}, folder: {minHeight: 76, flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 12, backgroundColor: '#FFF', borderColor: border, borderWidth: 1, borderRadius: 18},
  folderIcon: {width: 46, height: 46, backgroundColor: '#E7F0EB', borderRadius: 14, alignItems: 'center', justifyContent: 'center'}, folderIconText: {color: '#779B88', fontSize: 23}, folderCopy: {flex: 1, marginLeft: 12}, folderName: {color: ink, fontSize: 16, fontWeight: '600'}, meta: {color: muted, fontSize: 13, marginTop: 5}, chevron: {color: muted, fontSize: 25}, section: {fontSize: 18, color: ink, fontWeight: '600', marginHorizontal: 20, marginTop: 24, marginBottom: 12},
  folderImage: {width: 46, height: 46, borderRadius: 14},
  tabs: {height: 66, flexDirection: 'row', borderTopWidth: 1, borderColor: border, backgroundColor: '#FFF', paddingHorizontal: 8, paddingTop: 4}, tab: {flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center', gap: 3, borderRadius: 14}, tabSelected: {backgroundColor: '#F2F3F2'}, tabText: {fontSize: 12, color: muted}, tabActive: {color: ink, fontWeight: '700'},
  error: {color: '#A65757', fontSize: 14, margin: 16},
  viewer: {flex: 1, backgroundColor: '#161B22'}, viewerTop: {height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8}, viewerActions: {flexDirection: 'row'}, viewerButton: {width: 52, height: 52, justifyContent: 'center', alignItems: 'center'}, viewerCount: {color: '#FFFFFF', fontSize: 13, fontWeight: '600'}, viewerMedia: {flex: 1, justifyContent: 'center', overflow: 'hidden'}, fullMedia: {width: '100%', height: '100%'}, motionMedia: {position: 'absolute', width: '100%', height: '100%', top: 0, left: 0},
  liveBadge: {position: 'absolute', top: 12, left: 16, backgroundColor: '#161B22BB', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5}, liveBadgeText: {color: '#FFFFFF', fontSize: 11, fontWeight: '600'}, motionRetry: {position: 'absolute', bottom: 18, alignSelf: 'center', minHeight: 48, justifyContent: 'center', paddingHorizontal: 18, borderRadius: 16, backgroundColor: '#FFFFFFE8'}, motionRetryText: {color: ink, fontSize: 13, fontWeight: '600'},
  viewerSheet: {backgroundColor: paper, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingTop: 8, paddingHorizontal: 10}, viewerNav: {flexDirection: 'row', alignItems: 'center', minHeight: 64}, navButton: {minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center'}, viewerIdentity: {flex: 1, alignItems: 'center', paddingHorizontal: 4}, viewerName: {fontSize: 15, fontWeight: '600', color: ink, textAlign: 'center'}, viewerMeta: {fontSize: 12, color: muted, marginTop: 4}, viewerNotice: {fontSize: 13, color: ink, textAlign: 'center', marginBottom: 8},
});
