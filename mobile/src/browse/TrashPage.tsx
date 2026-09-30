import React, {useCallback, useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {ActivityIndicator, FlatList, Image, ScrollView, StyleSheet, Text, View} from 'react-native';
import {ApiError} from '../auth/api';
import {BrowseApi, type BatchFailure, type BatchResult, type Folder, type TrashItem} from './api';
import {Action, FolderPicker, Sheet, ui} from './ManagementUI';
import {operationError, runBatches} from './management';

function Preview({api, item}: {api: BrowseApi; item: TrashItem}) {
  const revision = useSyncExternalStore(api.subscribe, api.getRevision);
  const [source, setSource] = useState<{uri: string; headers: {Authorization: string}}>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true; setFailed(false); setSource(undefined);
    api.trashPreview(item.id).then(value => {if (active) {setSource(value);}}).catch(() => {if (active) {setFailed(true);}});
    return () => {active = false;};
  }, [api, item.id, revision]);
  return source && !failed ? <Image source={source} style={styles.preview} onError={() => setFailed(true)} /> : <View style={styles.preview}><Text style={ui.copy}>无预览</Text></View>;
}

export default function TrashPage({api, close}: {api: BrowseApi; close: () => void}) {
  const revision = useSyncExternalStore(api.subscribe, api.getRevision);
  const [items, setItems] = useState<TrashItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [retention, setRetention] = useState(30);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const generation = useRef(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [failures, setFailures] = useState<BatchFailure[]>([]);
  const [mode, setMode] = useState<'restore' | 'purge' | 'clear' | null>(null);
  const [target, setTarget] = useState<Folder | null>(null);
  const [rename, setRename] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const load = useCallback(async (next?: string) => {
    if (next && loadingRef.current) {return;}
    const ticket = ++generation.current;
    loadingRef.current = true; setLoading(true); setError('');
    try {
      const page = await api.listTrash(next);
      if (ticket !== generation.current) {return;}
      setItems(old => next ? [...old, ...page.items.filter(item => !old.some(existing => existing.id === item.id))] : page.items);
      setCursor(page.next_cursor); setRetention(page.retention_days); setPreviewRevision(value => value + 1);
      if (!next) {setSelected(new Set());}
    } catch (e) {
      if (ticket !== generation.current) {return;}
      if (next && e instanceof ApiError && e.status === 410) {loadingRef.current = false; await load(); return;}
      setError(operationError(e));
    } finally {if (ticket === generation.current) {loadingRef.current = false; setLoading(false);}}
  }, [api]);
  useEffect(() => {load(); const ticket = generation.current; return () => {generation.current = ticket + 1; loadingRef.current = false;};}, [load, revision]);
  const chosen = items.filter(item => selected.has(item.id));
  const owners = new Set(chosen.map(item => item.owner_id));
  function toggle(id: string) {
    setSelected(old => {const next = new Set(old); next.has(id) ? next.delete(id) : next.add(id); return next;});
  }
  function open(modeValue: 'restore' | 'purge' | 'clear') {
    setTarget(null); setRename(false); setMode(modeValue); setError('');
  }
  async function perform() {
    if (lock.current || !mode) {return;}
    lock.current = true; setBusy(true); setError(''); setNotice(''); setFailures([]);
    const result: BatchResult = {completed_ids: [], failed: []};
    try {
      if (mode === 'clear') {
        const before = new Date().toISOString();
        let more = true;
        while (more) {
          const batch = await api.emptyTrash(before);
          result.completed_ids.push(...batch.completed_ids); result.failed.push(...batch.failed);
          more = !!batch.has_more && batch.failed.length === 0 && batch.completed_ids.length > 0;
        }
      } else {
        const batch = await runBatches(chosen.map(item => item.id), ids => mode === 'restore' ? api.restoreTrash(ids, target?.id, rename) : api.purgeTrash(ids));
        result.completed_ids.push(...batch.completed_ids); result.failed.push(...batch.failed);
      }
      setMode(null);
      if (mode === 'clear') {await load();}
      setNotice(`已完成 ${result.completed_ids.length} 项${result.failed.length ? `，${result.failed.length} 项未完成` : ''}`);
    } catch (e) {setError(operationError(e)); setNotice(`已确认完成 ${result.completed_ids.length} 项，请刷新核对剩余内容。`);}
    finally {
      const completed = new Set(result.completed_ids);
      setItems(old => old.filter(item => !completed.has(item.id)));
      setFailures(result.failed); setSelected(new Set(result.failed.map(item => item.id)));
      setBusy(false); lock.current = false;
    }
  }
  async function retry(id: string) {
    if (lock.current) {return;}
    lock.current = true; setBusy(true); setError('');
    try {await api.retryTrash(id); await load();}
    catch (e) {setError(operationError(e));}
    finally {setBusy(false); lock.current = false;}
  }
  return <View style={styles.page}>
    <View style={ui.row}><Action label="返回图库" disabled={busy} onPress={close} /><Text style={ui.heading}>我的回收站</Text></View>
    <Text style={ui.copy}>新删除内容保留 {retention} 天，到期后自动清理。</Text>
    <View style={ui.row}>
      <Action label="刷新" disabled={busy || loading} onPress={() => {load();}} />
      <Action label="选择当前已加载项" disabled={busy || loading} onPress={() => setSelected(new Set(items.filter(item => item.state === 'trashed').map(item => item.id)))} />
      <Action label="取消选择" disabled={busy} onPress={() => setSelected(new Set())} />
    </View>
    <View style={ui.row}>
      <Text style={ui.copy}>已选 {chosen.length} 项</Text>
      <Action label="恢复" disabled={busy || loading || !chosen.length} onPress={() => open('restore')} />
      <Action label="永久删除" danger disabled={busy || loading || !chosen.length} onPress={() => open('purge')} />
      <Action label="清空我的回收站" danger disabled={busy || loading || !items.some(item => item.state === 'trashed')} onPress={() => open('clear')} />
    </View>
    {error ? <Text accessibilityRole="alert" style={ui.error}>{error}</Text> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={ui.copy}>{notice}</Text> : null}
    {failures.length ? <ScrollView style={ui.failures}>{failures.map(failure => <Text key={failure.id} style={ui.error}>{items.find(item => item.id === failure.id)?.filename ?? failure.id}：{operationError(failure.code)}</Text>)}</ScrollView> : null}
    <FlatList data={items} keyExtractor={item => item.id} extraData={selected}
      onEndReached={() => {if (cursor && !loading && !busy) {load(cursor);}}} onEndReachedThreshold={0.4}
      refreshing={loading && items.length === 0} onRefresh={() => {if (!busy) {load();}}}
      ListEmptyComponent={!loading && !error ? <Text style={ui.copy}>回收站为空</Text> : undefined}
      ListFooterComponent={<View>{loading || busy ? <ActivityIndicator /> : null}{error && cursor ? <Action label="重试加载更多" disabled={busy || loading} onPress={() => {load(cursor);}} /> : null}</View>}
      renderItem={({item}) => <View style={styles.item}>
        <View style={styles.identity}><Preview key={`${item.id}-${previewRevision}`} api={api} item={item} /><View style={styles.copy}>
          <Text style={styles.name}>{item.filename}</Text><Text style={ui.copy}>{item.folder_name} · {(item.size / 1024 / 1024).toFixed(1)} MB</Text>
          <Text style={ui.copy}>到期：{new Date(item.expires_at).toLocaleString()}（剩余 {Math.max(0, Math.ceil((Date.parse(item.expires_at) - Date.now()) / 86400000))} 天）</Text>
        </View></View>
        {item.state === 'trashed' ? <Action label={selected.has(item.id) ? `取消选择 ${item.filename}` : `选择 ${item.filename}`} selected={selected.has(item.id)} disabled={busy || loading} onPress={() => toggle(item.id)} /> :
          <><Text style={ui.copy}>文件操作待处理：{({moving: '移入中', restoring: '恢复中', purging: '清理中'} as const)[item.state]}</Text><Action label={`重试处理 ${item.filename}`} disabled={busy || loading} onPress={() => retry(item.id)} /></>}
        {item.state === 'trashed' && item.recovery_required ? <Action label={`重试处理 ${item.filename}`} disabled={busy || loading} onPress={() => retry(item.id)} /> : null}
      </View>} />
    {mode ? <Sheet title={mode === 'restore' ? '恢复照片' : mode === 'clear' ? '清空我的回收站？' : '永久删除？'} close={() => setMode(null)} busy={busy}>
      {mode === 'restore' ? <>
        <Text style={ui.copy}>默认恢复到原目录。原目录失效时请选择同一所有者的可写目录。</Text>
        <Action label={target ? `目标：${target.name}` : '恢复到原目录'} disabled={busy} onPress={() => setTarget(null)} />
        <Action label="选择其他目标目录" disabled={busy || owners.size !== 1} onPress={() => setChoosing(true)} />
        <Action label={rename ? '同名时自动改名：开' : '同名时自动改名：关'} selected={rename} disabled={busy} onPress={() => setRename(value => !value)} />
      </> : <Text style={ui.error}>{mode === 'clear' ? '永久删除我的回收站中本次确认前已删除的全部可清理内容，包括未加载的项目。' : `永久删除选中的 ${chosen.length} 项。`}此操作无法恢复。</Text>}
      <Action label={mode === 'restore' ? '确认恢复' : '确认永久删除'} danger={mode !== 'restore'} disabled={busy} onPress={perform} />
    </Sheet> : null}
    {choosing ? <FolderPicker api={api} ownerId={chosen[0]?.owner_id} close={() => setChoosing(false)} choose={folder => {setTarget(folder); setChoosing(false);}} /> : null}
  </View>;
}

const styles = StyleSheet.create({
  page: {flex: 1, padding: 12, backgroundColor: '#FAF9F7'},
  item: {padding: 12, marginVertical: 6, backgroundColor: '#FFF', borderRadius: 16, borderWidth: 1, borderColor: '#E8E5E1'},
  identity: {flexDirection: 'row', gap: 10}, copy: {flex: 1}, name: {color: '#3D4A5C', fontWeight: '600'},
  preview: {width: 64, height: 64, backgroundColor: '#ECE9E5', alignItems: 'center', justifyContent: 'center', borderRadius: 8},
});
