import React, {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Animated, AppState, BackHandler, Image, PanResponder, Pressable, ScrollView, StyleSheet, Switch, Text, View} from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import type {MobileSession} from '../auth/session';
import {BrowseApi, type Folder} from '../browse/api';
import {allowQueue, deleteStagedFiles, isCompleted, loadQueue, pairMedia, pickMedia, prepareUpload, saveQueue, uploadError, uploadOne, type UploadItem} from './queue';
import Icon from '../browse/Icon';
import BackupSettings from '../backup/BackupSettings';
import {colors, hairline, radius} from '../ui/theme';

type Props = {api: BrowseApi; session: MobileSession; active: boolean; incomingFolder: Folder | null; clearIncoming: () => void};

const ACTION_WIDTH = 84;
const OPEN_THRESHOLD = -42;
const DELETE_THRESHOLD = -132;

export default function UploadPage({api, session, active, incomingFolder, clearIncoming}: Props) {
  const accountKey = `${session.profile?.id ?? session.server}\n${session.username}`;
  const [items, setItems] = useState<UploadItem[]>([]);
  const itemsRef = useRef<UploadItem[]>([]);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const running = useRef(false);
  const queueEpoch = useRef(0);
  const currentUpload = useRef<{id: string; controller: AbortController} | null>(null);
  const mountedRef = useRef(true);
  const ready = useRef(false);
  const foreground = useRef(true);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [folder, setFolder] = useState<Folder | null>(null);
  const [pane, setPane] = useState<'manual' | 'backup'>('manual');
  const [dateFolders, setDateFolders] = useState(true);
  const [choosing, setChoosing] = useState(false);
  const [folderStack, setFolderStack] = useState<Folder[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [folderError, setFolderError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [resumeSignal, setResumeSignal] = useState(0);

  // Progress is display-only and restarts from zero after a relaunch, so it is
  // not written to storage: `persist` is false for those ticks.
  const commit = useCallback((next: UploadItem[], persist = true) => {
    if (!mountedRef.current) {return;}
    itemsRef.current = next;
    setItems(next);
    if (!persist) {return;}
    const scopedSession = sessionRef.current;
    saving.current = saving.current.catch(() => {}).then(() => saveQueue(scopedSession, next));
    saving.current.catch(() => setNotice('无法保存上传队列，请检查设备存储空间'));
  }, []);
  useEffect(() => {
    let mounted = true;
    const epoch = ++queueEpoch.current;
    mountedRef.current = true;
    allowQueue(sessionRef.current);
    ready.current = false;
    setFolder(null); setDateFolders(true); setPane('manual'); setChoosing(false); setBusy(false); setNotice('');
    loadQueue(sessionRef.current).then(next => {if (mounted) {commit(next); ready.current = true;}})
      .catch(() => {if (mounted) {setNotice('无法读取上传队列');}});
    const sub = AppState.addEventListener('change', state => {
      const wasForeground = foreground.current;
      foreground.current = state === 'active';
      if (foreground.current) {
        if (!wasForeground && ready.current) {
          const completed = itemsRef.current.filter(isCompleted);
          if (completed.length) {
            commit(itemsRef.current.filter(item => !isCompleted(item)));
            saving.current.then(() => deleteStagedFiles(completed)).catch(() => {});
          }
        }
        setResumeSignal(value => value + 1);
      }
    });
    return () => {mounted = false; mountedRef.current = false; queueEpoch.current = epoch + 1; currentUpload.current?.controller.abort(); sub.remove();};
  }, [accountKey, commit]);
  useEffect(() => {
    if (incomingFolder) {setFolder(incomingFolder); setPane('manual'); setChoosing(false); clearIncoming();}
  }, [incomingFolder, clearIncoming]);
  useEffect(() => {
    if (!active || !choosing) {return;}
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (folderStack.length) {setFolderStack(folderStack.slice(0, -1));}
      else {setChoosing(false);}
      return true;
    });
    return () => sub.remove();
  }, [active, choosing, folderStack]);

  useEffect(() => {
    if (!choosing) {return;}
    let mounted = true;
    setLoadingFolders(true);
    setFolderError('');
    setFolders([]);
    api.listFolders(folderStack.at(-1)?.id).then(list => {if (mounted) {setFolders(list);}})
      .catch(error => {if (mounted) {setFolderError(uploadError(error)); setFolders([]);}})
      .finally(() => {if (mounted) {setLoadingFolders(false);}});
    return () => {mounted = false;};
  }, [api, choosing, folderStack]);

  const process = useCallback(async () => {
    if (running.current || !ready.current || !foreground.current || !mountedRef.current) {return;}
    running.current = true;
    const epoch = queueEpoch.current;
    try {
      while (foreground.current && mountedRef.current && epoch === queueEpoch.current) {
        const item = itemsRef.current.find(entry => entry.status === 'waiting');
        if (!item) {break;}
        const controller = new AbortController();
        currentUpload.current = {id: item.id, controller};
        const update = (patch: Partial<UploadItem>, persist = true) => {
          if (controller.signal.aborted || epoch !== queueEpoch.current) {return;}
          commit(itemsRef.current.map(entry => entry.id === item.id && entry.status !== 'cancelled' ? {...entry, ...patch} : entry), persist);
        };
        update({status: 'uploading', progress: 0, message: undefined});
        try {
          if (!await ReactNativeBlobUtil.fs.exists(item.path) || (item.motion && !await ReactNativeBlobUtil.fs.exists(item.motion.path))) {
            update({status: 'failed', message: '本机文件已不可用，请重新选择'});
            continue;
          }
          if (controller.signal.aborted) {continue;}
          const prepared = await prepareUpload(api, item, controller.signal);
          if (controller.signal.aborted || epoch !== queueEpoch.current) {continue;}
          if (prepared !== item) {
            update({folderId: prepared.folderId, dateArchive: prepared.dateArchive});
            // A crash or lost upload response must not forget the leaf folder.
            await saving.current;
          }
          if (controller.signal.aborted || epoch !== queueEpoch.current) {continue;}
          const result = await uploadOne(api, prepared, value => update({progress: value}, false), controller.signal);
          update({status: result, progress: 100, message: result === 'skipped' ? '服务器已有相同内容' : undefined});
        } catch (error) {
          if (!controller.signal.aborted) {update({status: 'failed', progress: 0, message: uploadError(error)});}
        } finally {
          if (currentUpload.current?.controller === controller) {currentUpload.current = null;}
          if (mountedRef.current) {setResumeSignal(value => value + 1);}
        }
      }
    } finally {running.current = false; if (mountedRef.current && epoch !== queueEpoch.current) {setResumeSignal(value => value + 1);}}
  }, [api, commit]);
  useEffect(() => {process();}, [items, process, resumeSignal]);
  const cancelUpload = useLatest((id: string) => {
    const item = itemsRef.current.find(entry => entry.id === id);
    if (!item || !['waiting', 'uploading'].includes(item.status)) {return;}
    commit(itemsRef.current.map(entry => entry.id === id ? {...entry, status: 'cancelled', message: item.status === 'waiting' ? '已取消，保留本机文件供重试' : '已取消，保留文件供重试；服务器可能已接收，请刷新核对'} : entry));
    if (currentUpload.current?.id === id) {currentUpload.current.controller.abort();}
  });
  const retryUpload = useLatest((id: string) => {
    if (currentUpload.current?.id === id) {return;}
    commit(itemsRef.current.map(entry => entry.id === id ? {...entry, status: 'waiting', progress: 0, message: undefined} : entry));
  });
  const removeQueueItem = useLatest(async (item: UploadItem) => {
    if (currentUpload.current?.id === item.id) {return;}
    commit(itemsRef.current.filter(entry => entry.id !== item.id));
    try {await saving.current; await deleteStagedFiles([item]);}
    catch {setNotice('无法移除暂存文件，请检查设备存储空间');}
  });
  async function selectMedia() {
    if (!folder || busy) {return;}
    const epoch = queueEpoch.current;
    setBusy(true); setNotice('');
    try {
      const picked = await pickMedia();
      if (picked.length) {
        const selected = pairMedia(picked, folder, dateFolders);
        if (!mountedRef.current || epoch !== queueEpoch.current) {await deleteStagedFiles(selected); return;}
        commit([...itemsRef.current, ...selected]);
      }
    } catch (error) {if (mountedRef.current && epoch === queueEpoch.current) {setNotice(error instanceof Error ? error.message : '无法读取所选媒体');}}
    finally {if (mountedRef.current && epoch === queueEpoch.current) {setBusy(false);}}
  }
  const summary = {
    waiting: items.filter(item => item.status === 'waiting').length,
    uploading: items.filter(item => item.status === 'uploading').length,
    failed: items.filter(item => item.status === 'failed').length,
    cancelled: items.filter(item => item.status === 'cancelled').length,
  };
  const hasDeletable = summary.failed > 0 || summary.cancelled > 0;
  const destination = <Pressable style={({pressed}) => [styles.destination, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={`目标文件夹：${folder?.name ?? '未选择'}，点按更改`} onPress={() => {setFolderStack([]); setChoosing(true);}}>
    <View style={styles.destinationCopy}>
      <Text style={styles.rowLabel}>{pane === 'backup' || dateFolders ? '备份根目录' : '目标文件夹'}</Text>
      <Text style={styles.folderName} numberOfLines={1}>{folder?.name ?? '请选择可写目录'}</Text>
    </View>
    <Icon name="next" tone="muted" size={18} />
  </Pressable>;
  return <View style={[styles.root, !active && styles.hidden]} accessibilityElementsHidden={!active} importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}>
    <View style={styles.header}>
      <Text style={styles.title}>备份与上传</Text>
      <View style={styles.tabs} accessibilityRole="tablist">
        {(['manual', 'backup'] as const).map(tab => <Pressable key={tab} style={[styles.tab, pane === tab && styles.selectedTab]} accessibilityRole="tab" accessibilityLabel={tab === 'manual' ? '手动上传' : '自动备份设置'} accessibilityState={{selected: pane === tab}} onPress={() => {setPane(tab); setChoosing(false);}}>
          <Text style={[styles.tabText, pane === tab && styles.selectedTabText]}>{tab === 'manual' ? '手动上传' : '自动备份'}</Text>
        </Pressable>)}
      </View>
    </View>
    <View style={[styles.body, (pane !== 'backup' || choosing) && styles.hidden]} accessibilityElementsHidden={pane !== 'backup' || choosing} importantForAccessibility={pane === 'backup' && !choosing ? 'auto' : 'no-hide-descendants'}>
      <ScrollView contentContainerStyle={styles.content}>
        {pane === 'backup' && !choosing ? <View style={styles.group}>{destination}</View> : null}
        <BackupSettings session={session} api={api} folder={folder} />
      </ScrollView>
    </View>
    {choosing ? <View style={styles.chooser}>
      <View style={styles.chooserHeader}>
        <Text style={styles.sectionTitle}>选择目标文件夹</Text>
        <Pressable style={styles.ghostButton} accessibilityRole="button" accessibilityLabel="关闭文件夹选择" onPress={() => setChoosing(false)}><Text style={styles.ghostText}>关闭</Text></Pressable>
      </View>
      <Text style={styles.chooserPath} numberOfLines={2}>{folderStack.length ? folderStack.map(entry => entry.name).join(' / ') : '服务器根目录'}</Text>
      {folderStack.length ? <View style={styles.currentFolderRow}>
        <Pressable style={styles.pillButton} accessibilityRole="button" accessibilityLabel="返回上级目标目录" onPress={() => setFolderStack(folderStack.slice(0, -1))}>
          <View style={styles.inline}><Icon name="back" size={16} /><Text style={styles.pillText}>上级</Text></View>
        </Pressable>
        {folderStack.at(-1)?.effective_permission === 'write' ? <Pressable style={styles.selectFolder} accessibilityRole="button" accessibilityLabel={`选择当前目录 ${folderStack.at(-1)?.name}`} onPress={() => {setFolder(folderStack.at(-1) ?? null); setChoosing(false);}}><Text style={styles.selectFolderText}>选择此目录</Text></Pressable> : <Text style={styles.readOnly}>此目录只读</Text>}
      </View> : null}
      <ScrollView style={styles.folderList} contentContainerStyle={styles.folderListContent}>
        {loadingFolders ? <ActivityIndicator style={styles.spinner} color={colors.ink} /> : folders.length ? <View style={styles.group}>
          {folders.map((candidate, index) => <Pressable key={candidate.id} style={({pressed}) => [styles.folderRow, index > 0 && styles.rowDivider, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={`进入 ${candidate.name}${candidate.effective_permission === 'write' ? '，可选择上传' : '，只读'}`} onPress={() => setFolderStack([...folderStack, candidate])}>
            <View style={styles.folderPick}>
              <Text style={styles.folderName}>{candidate.name}</Text>
              <Text style={styles.meta}>{candidate.effective_permission === 'write' ? '进入查看子目录或选定此目录' : '只读目录'}</Text>
            </View>
            <Icon name="next" tone="muted" size={18} />
          </Pressable>)}
        </View> : null}
        {folderError ? <Text accessibilityRole="alert" style={styles.notice}>{folderError}</Text> : null}
        {!loadingFolders && !folderError && !folders.length ? <Text style={styles.chooserEmpty}>这里没有子文件夹</Text> : null}
      </ScrollView>
    </View> : pane === 'manual' ? <ScrollView testID="manual-upload-content" style={styles.body} contentContainerStyle={styles.content}>
      <View style={styles.group}>
        {destination}
        <View style={[styles.archiveOption, styles.rowDivider]}>
          <View style={styles.archiveCopy}>
            <Text style={styles.optionTitle}>按年月日归档</Text>
            <Text style={styles.meta}>{dateFolders ? '按拍摄日期上传到 根目录/年/月/日' : '直接上传到所选目录'}</Text>
          </View>
          <Switch accessibilityLabel="手动上传按年月日归档" value={dateFolders} disabled={busy}
            trackColor={{false: '#DED9D2', true: colors.sageBar}} thumbColor={colors.surface} onValueChange={setDateFolders} />
        </View>
      </View>
      <Pressable style={({pressed}) => [styles.primary, (!folder || busy) && styles.disabled, pressed && !(!folder || busy) && styles.pressed]}
        accessibilityRole="button" accessibilityLabel="选择照片与视频并加入手选上传队列" disabled={!folder || busy} onPress={selectMedia}>
        <Text style={styles.primaryText}>{busy ? '正在保存所选文件…' : '选择照片与视频'}</Text>
      </Pressable>
      {notice ? <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text> : null}
      <View style={styles.queueHeading}>
        <Text style={styles.queueTitle}>上传队列</Text>
        <Text style={styles.queueCount}>{items.length ? `共 ${items.length} 项` : '空闲'}</Text>
      </View>
      {items.length > 0 ? <View style={styles.summary}>
        <Stat label="等待" count={summary.waiting} tone="muted" />
        <Stat label="上传中" count={summary.uploading} tone="sage" />
        <Stat label="失败" count={summary.failed} tone="danger" />
        <Stat label="已取消" count={summary.cancelled} tone="muted" />
      </View> : null}
      {hasDeletable ? <Text style={styles.swipeHint}>左滑失败或已取消的项目可删除</Text> : null}
      {items.length === 0 ? <View style={styles.queueEmpty}>
        <Text style={styles.emptyTitle}>队列为空</Text>
        <Text style={styles.meta}>选择目标文件夹后，从相册挑选照片或视频即可开始上传。</Text>
      </View> : <View style={styles.queueList}>
        {[...items].reverse().map((item, index) => <QueueRow key={item.id} item={item} divider={index > 0}
          settling={currentUpload.current?.id === item.id} cancel={cancelUpload} retry={retryUpload} remove={removeQueueItem} />)}
      </View>}
    </ScrollView> : null}
  </View>;
}

function Stat({label, count, tone}: {label: string; count: number; tone: 'muted' | 'sage' | 'danger'}) {
  const dotColor = count === 0 ? colors.subtle : tone === 'danger' ? colors.danger : tone === 'sage' ? colors.sage : colors.ink;
  return <View style={styles.statItem}>
    <View style={[styles.statDot, {backgroundColor: dotColor}]} />
    <Text style={[styles.summaryText, count > 0 && tone === 'danger' && styles.summaryDanger]}>{label} {count}</Text>
  </View>;
}

// Stable wrapper around the latest closure, so queue rows can stay memoized.
function useLatest<Args extends unknown[], Result>(handler: (...args: Args) => Result): (...args: Args) => Result {
  const latest = useRef(handler);
  latest.current = handler;
  return useCallback((...args: Args) => latest.current(...args), []);
}

const STATUS_LABELS: Record<UploadItem['status'], string> = {
  waiting: '等待中', uploading: '上传中', success: '已完成', skipped: '已跳过', failed: '上传失败', cancelled: '已取消',
};

// A progress tick replaces one item object; memoization re-renders only its row.
const QueueRow = memo(function Row({item, divider, settling, cancel, retry, remove}: {
  item: UploadItem; divider: boolean; settling: boolean;
  cancel: (id: string) => void; retry: (id: string) => void; remove: (item: UploadItem) => void;
}) {
  const deletable = item.status === 'failed' || item.status === 'cancelled';
  const translateX = useRef(new Animated.Value(0)).current;
  const offset = useRef(0);
  const latest = useRef({deletable, settling, item, remove});
  latest.current = {deletable, settling, item, remove};

  const snap = useCallback((toValue: number) => {
    offset.current = toValue;
    Animated.spring(translateX, {toValue, useNativeDriver: true, bounciness: 0, speed: 22}).start();
  }, [translateX]);

  useEffect(() => {
    if (!deletable && offset.current !== 0) {snap(0);}
  }, [deletable, snap]);

  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gesture) => {
      if (!latest.current.deletable || latest.current.settling) {return false;}
      const horizontal = Math.abs(gesture.dx) > 10 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5;
      if (!horizontal) {return false;}
      return offset.current < 0 || gesture.dx < -6;
    },
    onPanResponderMove: (_event, gesture) => {
      const next = Math.max(-180, Math.min(0, offset.current + gesture.dx));
      translateX.setValue(next);
    },
    onPanResponderRelease: (_event, gesture) => {
      const current = Math.max(-180, Math.min(0, offset.current + gesture.dx));
      if (!latest.current.settling && (current <= DELETE_THRESHOLD || (gesture.vx <= -0.65 && current <= -64))) {
        offset.current = -360;
        Animated.timing(translateX, {toValue: -360, duration: 140, useNativeDriver: true}).start(() => {
          latest.current.remove(latest.current.item);
        });
      } else if (current <= OPEN_THRESHOLD || (gesture.vx <= -0.3 && current < -16)) {
        snap(-ACTION_WIDTH);
      } else {
        snap(0);
      }
    },
    onPanResponderTerminate: () => {
      snap(offset.current < 0 ? -ACTION_WIDTH : 0);
    },
    onPanResponderTerminationRequest: () => false,
  }), [snap, translateX]);

  const removeLabel = item.status === 'cancelled' ? `移除已取消的 ${item.name}` : `删除失败的 ${item.name}`;
  const isError = item.status === 'failed';

  const rowContent = <View style={styles.item}>
    {item.mime.startsWith('image/') || item.thumbnailPath ?
      <Image source={{uri: `file://${item.thumbnailPath ?? item.path}`}} style={styles.thumb} resizeMethod="resize" /> :
      <View style={styles.thumbPlaceholder}><Icon name="video" size={24} /></View>}
    <View style={styles.itemBody}>
      <Text style={styles.fileName} numberOfLines={1}>{item.name}{item.motion ? ' · 动态' : ''}</Text>
      <Text style={styles.meta} numberOfLines={1}>{item.folderName}</Text>
      <Text style={[styles.statusLine, isError && styles.statusError]} numberOfLines={2}>
        {STATUS_LABELS[item.status]} · {item.progress}%{item.message ? ` · ${item.message}` : ''}
      </Text>
      <View style={styles.track}><View style={[styles.fill, isError && styles.fillError, {width: `${item.progress}%`}]} /></View>
    </View>
    <View style={styles.rowActions}>
      {item.status === 'waiting' || item.status === 'uploading' ? <Pressable style={styles.rowButton} accessibilityRole="button" accessibilityLabel={`取消上传 ${item.name}`} onPress={() => cancel(item.id)}>
        <Text style={styles.rowButtonText}>取消</Text>
      </Pressable> : null}
      {item.status === 'failed' || item.status === 'cancelled' ? <Pressable style={styles.rowButton} accessibilityRole="button" accessibilityLabel={`重试上传 ${item.name}`} disabled={settling} onPress={() => {snap(0); retry(item.id);}}>
        <Text style={styles.rowButtonText}>{settling ? '取消中…' : '重试'}</Text>
      </Pressable> : null}
    </View>
  </View>;

  return <View style={[styles.swipeContainer, divider && styles.rowDivider]}>
    {deletable ? <View style={styles.deleteUnderlay}>
      <Pressable style={[styles.deleteAction, settling && styles.disabled]} accessibilityRole="button" accessibilityLabel={removeLabel}
        disabled={settling} onPress={() => remove(item)}>
        <Text style={styles.deleteActionText}>删除</Text>
      </Pressable>
    </View> : null}
    {deletable ? <Animated.View style={[styles.swipeForeground, {transform: [{translateX}]}]} {...pan.panHandlers}>
      {rowContent}
    </Animated.View> : rowContent}
  </View>;
});

const styles = StyleSheet.create({
  root: {flex: 1, paddingTop: 14, backgroundColor: colors.paper}, hidden: {display: 'none'},
  header: {paddingHorizontal: 16, paddingBottom: 10},
  title: {fontSize: 24, fontWeight: '700', color: colors.ink, letterSpacing: -0.4},
  tabs: {flexDirection: 'row', marginTop: 12, padding: 3, backgroundColor: colors.recessed, borderRadius: radius.md},
  tab: {flex: 1, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 9},
  selectedTab: {backgroundColor: colors.surface},
  tabText: {color: colors.muted, fontSize: 13, fontWeight: '500'},
  selectedTabText: {color: colors.ink, fontWeight: '600'},
  body: {flex: 1, minHeight: 0}, content: {paddingBottom: 28},
  group: {marginHorizontal: 16, marginTop: 8, backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden'},
  rowDivider: {borderTopWidth: hairline, borderTopColor: colors.hairline},
  destination: {minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10},
  destinationCopy: {flex: 1, marginRight: 8},
  rowLabel: {color: colors.muted, fontSize: 12},
  folderName: {color: colors.ink, fontSize: 15, fontWeight: '600', marginTop: 2},
  archiveOption: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12},
  archiveCopy: {flex: 1, marginRight: 12}, optionTitle: {color: colors.ink, fontSize: 15, fontWeight: '500'},
  meta: {color: colors.muted, fontSize: 12, marginTop: 2},
  primary: {minHeight: 48, backgroundColor: colors.ink, marginHorizontal: 16, marginTop: 12, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center'},
  disabled: {opacity: 0.48}, pressed: {opacity: 0.78},
  primaryText: {color: colors.paper, fontSize: 15, fontWeight: '600'},
  notice: {color: colors.danger, fontSize: 13, marginHorizontal: 16, marginTop: 10},
  queueHeading: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginHorizontal: 16, marginTop: 20, marginBottom: 8},
  queueTitle: {fontSize: 15, color: colors.ink, fontWeight: '600'},
  queueCount: {fontSize: 12, color: colors.muted},
  summary: {flexDirection: 'row', justifyContent: 'space-between', marginHorizontal: 16, marginBottom: 10, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: colors.recessed, borderRadius: radius.md},
  statItem: {flexDirection: 'row', alignItems: 'center', gap: 6},
  statDot: {width: 6, height: 6, borderRadius: 3},
  summaryText: {color: colors.ink, fontSize: 12, fontWeight: '500'},
  summaryDanger: {color: colors.danger, fontWeight: '600'},
  swipeHint: {color: colors.muted, fontSize: 12, marginHorizontal: 16, marginBottom: 8},
  queueEmpty: {marginHorizontal: 16, paddingVertical: 28, paddingHorizontal: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, alignItems: 'center'},
  emptyTitle: {color: colors.ink, fontSize: 15, fontWeight: '600', marginBottom: 4},
  queueList: {marginHorizontal: 16, backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden'},
  swipeContainer: {position: 'relative', overflow: 'hidden', backgroundColor: colors.surface},
  swipeForeground: {backgroundColor: colors.surface},
  deleteUnderlay: {position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, flexDirection: 'row', justifyContent: 'flex-end', backgroundColor: colors.danger},
  deleteAction: {width: ACTION_WIDTH, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.danger},
  deleteActionText: {color: '#FFFFFF', fontSize: 14, fontWeight: '600'},
  item: {minHeight: 78, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, paddingHorizontal: 12, paddingVertical: 10},
  thumb: {width: 52, height: 52, borderRadius: radius.sm},
  thumbPlaceholder: {width: 52, height: 52, borderRadius: radius.sm, backgroundColor: colors.sandSoft, alignItems: 'center', justifyContent: 'center'},
  itemBody: {flex: 1, marginLeft: 12, marginRight: 8},
  fileName: {fontSize: 14, color: colors.ink, fontWeight: '600'},
  statusLine: {fontSize: 12, color: colors.muted, marginTop: 3},
  statusError: {color: colors.danger},
  track: {height: 3, backgroundColor: colors.hairline, borderRadius: 2, marginTop: 7, overflow: 'hidden'},
  fill: {height: 3, backgroundColor: colors.sageBar, borderRadius: 2},
  fillError: {backgroundColor: colors.danger},
  rowActions: {justifyContent: 'center'},
  rowButton: {minWidth: 48, minHeight: 34, paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: colors.recessed, borderWidth: 1, borderColor: colors.border, justifyContent: 'center', alignItems: 'center'},
  rowButtonText: {color: colors.ink, fontSize: 12, fontWeight: '600'},
  chooser: {flex: 1, marginTop: 4},
  chooserHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16},
  sectionTitle: {fontSize: 17, color: colors.ink, fontWeight: '600'},
  ghostButton: {minHeight: 40, justifyContent: 'center', paddingHorizontal: 10},
  ghostText: {color: colors.ink, fontSize: 14, fontWeight: '600'},
  chooserPath: {color: colors.muted, fontSize: 12, marginHorizontal: 16, marginTop: 4, marginBottom: 10},
  currentFolderRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginHorizontal: 16, marginBottom: 10},
  pillButton: {minHeight: 38, justifyContent: 'center', paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: colors.recessed, borderWidth: 1, borderColor: colors.border},
  pillText: {color: colors.ink, fontSize: 13, fontWeight: '600'},
  inline: {flexDirection: 'row', alignItems: 'center', gap: 4},
  selectFolder: {minHeight: 38, justifyContent: 'center', paddingHorizontal: 16, borderRadius: radius.pill, backgroundColor: colors.ink},
  selectFolderText: {color: colors.paper, fontSize: 13, fontWeight: '600'},
  readOnly: {color: colors.muted, fontSize: 12},
  folderList: {flex: 1}, folderListContent: {paddingBottom: 24},
  spinner: {marginTop: 20},
  folderRow: {minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8},
  folderPick: {flex: 1, justifyContent: 'center', marginRight: 8},
  chooserEmpty: {color: colors.muted, fontSize: 14, marginTop: 24, textAlign: 'center'},
});
