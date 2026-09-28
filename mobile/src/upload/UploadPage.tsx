import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, AppState, BackHandler, Image, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import type {MobileSession} from '../auth/session';
import {BrowseApi, type Folder} from '../browse/api';
import {allowQueue, deleteStagedFiles, isCompleted, loadQueue, pairMedia, pickMedia, saveQueue, uploadError, uploadOne, type UploadItem} from './queue';
import Icon from '../browse/Icon';

const ink = '#3D4A5C';
const muted = '#75808A';
type Props = {api: BrowseApi; session: MobileSession; active: boolean; incomingFolder: Folder | null; clearIncoming: () => void};

export default function UploadPage({api, session, active, incomingFolder, clearIncoming}: Props) {
  const accountKey = `${session.profile?.id ?? session.server}\n${session.username}`;
  const [items, setItems] = useState<UploadItem[]>([]);
  const itemsRef = useRef<UploadItem[]>([]);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const running = useRef(false);
  const mountedRef = useRef(true);
  const ready = useRef(false);
  const foreground = useRef(true);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [folder, setFolder] = useState<Folder | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [folderStack, setFolderStack] = useState<Folder[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [folderError, setFolderError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [resumeSignal, setResumeSignal] = useState(0);

  const commit = useCallback((next: UploadItem[]) => {
    if (!mountedRef.current) {return;}
    itemsRef.current = next;
    setItems(next);
    saving.current = saving.current.catch(() => {}).then(() => saveQueue(sessionRef.current, next));
    saving.current.catch(() => setNotice('无法保存上传队列，请检查设备存储空间'));
  }, []);
  useEffect(() => {
    let mounted = true;
    mountedRef.current = true;
    allowQueue(sessionRef.current);
    ready.current = false;
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
    return () => {mounted = false; mountedRef.current = false; sub.remove();};
  }, [accountKey, commit]);
  useEffect(() => {
    if (incomingFolder) {setFolder(incomingFolder); setChoosing(false); clearIncoming();}
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
    if (running.current || !ready.current || !foreground.current) {return;}
    running.current = true;
    try {
      while (foreground.current) {
        const item = itemsRef.current.find(entry => entry.status === 'waiting');
        if (!item) {break;}
        const update = (patch: Partial<UploadItem>) => commit(itemsRef.current.map(entry => entry.id === item.id ? {...entry, ...patch} : entry));
        if (!await ReactNativeBlobUtil.fs.exists(item.path) || (item.motion && !await ReactNativeBlobUtil.fs.exists(item.motion.path))) {
          update({status: 'failed', message: '本机文件已不可用，请重新选择'});
          continue;
        }
        update({status: 'uploading', progress: 0, message: undefined});
        try {
          const result = await uploadOne(api, item, value => update({progress: value}));
          update({status: result, progress: 100, message: result === 'skipped' ? '服务器已有相同内容' : undefined});
        } catch (error) {update({status: 'failed', progress: 0, message: uploadError(error)});}
      }
    } finally {running.current = false;}
  }, [api, commit]);
  useEffect(() => {process();}, [items, process, resumeSignal]);
  async function selectMedia() {
    if (!folder || busy) {return;}
    setBusy(true); setNotice('');
    try {
      const picked = await pickMedia();
      if (picked.length) {commit([...itemsRef.current, ...pairMedia(picked, folder)]);}
    } catch (error) {setNotice(error instanceof Error ? error.message : '无法读取所选媒体');}
    finally {setBusy(false);}
  }
  const summary = {
    waiting: items.filter(item => item.status === 'waiting').length,
    uploading: items.filter(item => item.status === 'uploading').length,
    failed: items.filter(item => item.status === 'failed').length,
  };
  return <View style={[styles.root, !active && styles.hidden]} accessibilityElementsHidden={!active} importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}>
    <Text style={styles.title}>备份</Text>
    <Text style={styles.subtitle}>只上传您在系统选择器中选中的照片和视频。离开应用后上传可能中断，返回时可重试。</Text>
    <View style={styles.summary}><Text style={styles.summaryText}>等待 {summary.waiting}</Text><Text style={styles.summaryText}>上传中 {summary.uploading}</Text><Text style={styles.summaryText}>失败 {summary.failed}</Text></View>
    {choosing ? <View style={styles.chooser}>
      <View style={styles.row}><Text style={styles.section}>选择服务器目标文件夹</Text><Pressable style={styles.action} accessibilityRole="button" accessibilityLabel="关闭文件夹选择" onPress={() => setChoosing(false)}><Text style={styles.actionText}>关闭</Text></Pressable></View>
      <Text style={styles.chooserPath} numberOfLines={2}>{folderStack.length ? folderStack.map(entry => entry.name).join(' / ') : '服务器文件夹'}</Text>
      {folderStack.length ? <View style={styles.currentFolderRow}>
        <Pressable style={styles.action} accessibilityRole="button" accessibilityLabel="返回上级目标目录" onPress={() => setFolderStack(folderStack.slice(0, -1))}><View style={styles.inline}><Icon name="back" size={18} /><Text style={styles.actionText}>上级</Text></View></Pressable>
        {folderStack.at(-1)?.effective_permission === 'write' ? <Pressable style={styles.selectFolder} accessibilityRole="button" accessibilityLabel={`选择当前目录 ${folderStack.at(-1)?.name}`} onPress={() => {setFolder(folderStack.at(-1) ?? null); setChoosing(false);}}><Text style={styles.selectFolderText}>选择此目录</Text></Pressable> : <Text style={styles.readOnly}>此目录只读</Text>}
      </View> : null}
      <ScrollView style={styles.folderList}>
        {loadingFolders ? <ActivityIndicator color={ink} /> : folders.map(candidate => <Pressable key={candidate.id} style={styles.folderRow} accessibilityRole="button" accessibilityLabel={`进入 ${candidate.name}${candidate.effective_permission === 'write' ? '，可选择上传' : '，只读'}`} onPress={() => setFolderStack([...folderStack, candidate])}>
          <View style={styles.folderPick}><Text style={styles.folderName}>{candidate.name}</Text><Text style={styles.meta}>{candidate.effective_permission === 'write' ? '进入后可选择此目录' : '只读目录'}</Text></View><Icon name="next" size={20} />
        </Pressable>)}
        {folderError ? <Text accessibilityRole="alert" style={styles.notice}>{folderError}</Text> : null}
        {!loadingFolders && !folderError && !folders.length ? <Text style={styles.chooserEmpty}>这里没有子文件夹</Text> : null}
      </ScrollView>
    </View> : <>
      <Pressable style={styles.destination} accessibilityRole="button" accessibilityLabel={`目标文件夹：${folder?.name ?? '未选择'}，点按更改`} onPress={() => {setFolderStack([]); setChoosing(true);}}><View style={styles.destinationCopy}><Text style={styles.meta}>服务器目标文件夹</Text><Text style={styles.folderName}>{folder?.name ?? '请选择有写入权限的文件夹'}</Text></View><Icon name="next" tone="muted" size={20} /></Pressable>
      <Pressable style={[styles.primary, (!folder || busy) && styles.disabled]} accessibilityRole="button" accessibilityLabel="选择照片与视频并加入手选上传队列" disabled={!folder || busy} onPress={selectMedia}><Text style={styles.primaryText}>{busy ? '正在保存所选文件…' : '选择照片与视频'}</Text></Pressable>
      {notice ? <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text> : null}
      <Text style={styles.section}>上传队列</Text>
      <ScrollView contentContainerStyle={styles.queue}>
        {items.length === 0 ? <View style={styles.queueEmpty}><Text style={styles.emptyTitle}>队列还是空的</Text><Text style={styles.meta}>选择目标文件夹后，从系统相册手动选择照片和视频。</Text></View> : [...items].reverse().map(item => <View key={item.id} style={styles.item}>
          {item.mime.startsWith('image/') || item.thumbnailPath ? <Image source={{uri: `file://${item.thumbnailPath ?? item.path}`}} style={styles.thumb} /> : <View style={styles.thumbPlaceholder}><Icon name="video" size={26} /></View>}
          <View style={styles.itemBody}><Text style={styles.fileName} numberOfLines={1}>{item.name}{item.motion ? ' · 动态照片' : ''}</Text>
            <Text style={styles.meta} numberOfLines={1}>目标：{item.folderName}</Text>
            <Text style={styles.meta}>{({waiting: '等待', uploading: '上传中', success: '成功', skipped: '跳过', failed: '失败'} as const)[item.status]} · {item.progress}%{item.message ? ` · ${item.message}` : ''}</Text>
            <View style={styles.track}><View style={[styles.fill, {width: `${item.progress}%`}]} /></View>
          </View>
          {item.status === 'failed' ? <Pressable style={styles.retry} accessibilityRole="button" accessibilityLabel={`重试上传 ${item.name}`} onPress={() => commit(itemsRef.current.map(entry => entry.id === item.id ? {...entry, status: 'waiting', progress: 0, message: undefined} : entry))}><Text style={styles.actionText}>重试</Text></Pressable> : null}
        </View>)}
      </ScrollView>
    </>}
  </View>;
}

const styles = StyleSheet.create({
  root: {flex: 1, paddingTop: 18, backgroundColor: '#FAF9F7'}, hidden: {display: 'none'},
  title: {fontSize: 26, fontWeight: '700', color: ink, marginHorizontal: 20},
  subtitle: {fontSize: 14, lineHeight: 21, color: muted, marginHorizontal: 20, marginTop: 8, marginBottom: 16},
  summary: {flexDirection: 'row', justifyContent: 'space-around', marginHorizontal: 16, paddingVertical: 16, backgroundColor: '#F0EEEA', borderRadius: 18},
  summaryText: {color: ink, fontSize: 14}, destination: {minHeight: 68, flexDirection: 'row', alignItems: 'center', margin: 16, paddingHorizontal: 16, borderWidth: 1, borderColor: '#E8E5E1', backgroundColor: '#FFF', borderRadius: 16}, destinationCopy: {flex: 1, justifyContent: 'center'},
  folderName: {color: ink, fontSize: 16, fontWeight: '600'}, meta: {color: muted, fontSize: 12, marginTop: 4},
  primary: {minHeight: 52, backgroundColor: ink, marginHorizontal: 16, borderRadius: 16, alignItems: 'center', justifyContent: 'center'}, disabled: {opacity: 0.5}, primaryText: {color: '#FFF', fontSize: 16, fontWeight: '600'},
  notice: {color: '#A65757', marginHorizontal: 20, marginTop: 10}, section: {fontSize: 18, color: ink, fontWeight: '600', marginHorizontal: 20, marginTop: 18, marginBottom: 10},
  queue: {paddingBottom: 28}, queueEmpty: {marginHorizontal: 16, padding: 22, backgroundColor: '#FFF', borderWidth: 1, borderColor: '#E8E5E1', borderRadius: 18}, emptyTitle: {color: ink, fontSize: 15, fontWeight: '600'}, item: {minHeight: 92, flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', borderRadius: 16, borderWidth: 1, borderColor: '#E8E5E1', marginHorizontal: 16, marginBottom: 8, padding: 10},
  thumb: {width: 60, height: 60, borderRadius: 10}, thumbPlaceholder: {width: 60, height: 60, borderRadius: 10, backgroundColor: '#E8D4B8', alignItems: 'center', justifyContent: 'center'},
  itemBody: {flex: 1, marginLeft: 10}, fileName: {fontSize: 14, color: ink, fontWeight: '600'}, track: {height: 4, backgroundColor: '#E8E5E1', borderRadius: 2, marginTop: 8}, fill: {height: 4, backgroundColor: '#A8C5B8', borderRadius: 2},
  retry: {minWidth: 48, minHeight: 48, justifyContent: 'center', alignItems: 'center'}, actionText: {color: ink, fontSize: 15}, action: {minWidth: 48, minHeight: 48, justifyContent: 'center', paddingHorizontal: 12}, inline: {flexDirection: 'row', alignItems: 'center', gap: 6},
  chooser: {flex: 1, marginTop: 12}, row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'}, chooserPath: {color: muted, fontSize: 13, marginHorizontal: 20, marginBottom: 10}, currentFolderRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginHorizontal: 16, marginBottom: 12}, selectFolder: {minHeight: 48, justifyContent: 'center', paddingHorizontal: 20, borderRadius: 14, backgroundColor: ink}, selectFolderText: {color: '#FFF', fontSize: 14, fontWeight: '600'}, readOnly: {color: muted, fontSize: 13}, folderList: {flex: 1, paddingHorizontal: 16}, folderRow: {minHeight: 64, backgroundColor: '#FFF', flexDirection: 'row', alignItems: 'center', borderRadius: 16, borderWidth: 1, borderColor: '#E8E5E1', marginBottom: 8, paddingRight: 16}, folderPick: {flex: 1, minHeight: 64, justifyContent: 'center', paddingHorizontal: 14}, chooserEmpty: {color: muted, fontSize: 14, marginTop: 12, textAlign: 'center'},
});
