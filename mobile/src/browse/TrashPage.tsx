import React, {useCallback, useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {ActivityIndicator, FlatList, Image, ScrollView, StyleSheet, Text, View} from 'react-native';
import {ApiError} from '../auth/api';
import {BrowseApi, type BatchFailure, type BatchResult, type Folder, type TrashItem} from './api';
import {Action, FolderPicker, Sheet, ui} from './ManagementUI';
import {operationError, runBatches} from './management';
import {colors, hairline, radius} from '../ui/theme';

function Preview({api, item}: {api: BrowseApi; item: TrashItem}) {
  const revision = useSyncExternalStore(api.subscribe, api.getRevision);
  const [source, setSource] = useState<{uri: string; headers: {Authorization: string}}>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true; setFailed(false); setSource(undefined);
    api.trashPreview(item.id).then(value => {if (active) {setSource(value);}}).catch(() => {if (active) {setFailed(true);}});
    return () => {active = false;};
  }, [api, item.id, revision]);
  return source && !failed ? <Image source={source} style={styles.preview} onError={() => setFailed(true)} /> : <View style={styles.preview}><Text style={styles.previewFallback}>无预览</Text></View>;
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
  // Restored photos return to the library at arbitrary dates, so the gallery
  // reloads once on leaving. Deleting from trash never changes the gallery.
  const restored = useRef(false);
  useEffect(() => () => {if (restored.current) {api.refreshBrowsing(true);}}, [api]);
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
      if (mode === 'restore' && result.completed_ids.length) {restored.current = true;}
      setFailures(result.failed); setSelected(new Set(result.failed.map(item => item.id)));
      setBusy(false); lock.current = false;
    }
  }
  async function retry(id: string) {
    if (lock.current) {return;}
    lock.current = true; setBusy(true); setError('');
    try {await api.retryTrash(id); restored.current = true; await load();}
    catch (e) {setError(operationError(e));}
    finally {setBusy(false); lock.current = false;}
  }
  return <View style={styles.page}>
    <View style={styles.header}>
      <Action label="返回图库" variant="ghost" disabled={busy} onPress={close} />
      <Text style={styles.headerTitle}>我的回收站</Text>
      <Action label="刷新" variant="ghost" disabled={busy || loading} onPress={() => {load();}} />
    </View>
    <Text style={styles.caption}>新删除内容保留 {retention} 天，到期后自动清理 · 已选 {chosen.length} 项</Text>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.toolbar} contentContainerStyle={styles.toolbarContent}>
      <Action label="选择当前已加载项" disabled={busy || loading} onPress={() => setSelected(new Set(items.filter(item => item.state === 'trashed').map(item => item.id)))} />
      <Action label="取消选择" disabled={busy} onPress={() => setSelected(new Set())} />
      <Action label="恢复" disabled={busy || loading || !chosen.length} onPress={() => open('restore')} />
      <Action label="永久删除" danger disabled={busy || loading || !chosen.length} onPress={() => open('purge')} />
      <Action label="清空我的回收站" danger disabled={busy || loading || !items.some(item => item.state === 'trashed')} onPress={() => open('clear')} />
    </ScrollView>
    {error ? <Text accessibilityRole="alert" style={styles.bannerError}>{error}</Text> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={styles.bannerNotice}>{notice}</Text> : null}
    {failures.length ? <ScrollView style={ui.failures}>{failures.map(failure => <Text key={failure.id} style={styles.bannerError}>{items.find(item => item.id === failure.id)?.filename ?? failure.id}：{operationError(failure.code)}</Text>)}</ScrollView> : null}
    <FlatList data={items} keyExtractor={item => item.id} extraData={selected} contentContainerStyle={styles.listContent}
      onEndReached={() => {if (cursor && !loading && !busy) {load(cursor);}}} onEndReachedThreshold={0.4}
      refreshing={loading && items.length === 0} onRefresh={() => {if (!busy) {load();}}}
      ListEmptyComponent={!loading && !error ? <Text style={styles.empty}>回收站为空</Text> : undefined}
      ListFooterComponent={<View>{loading || busy ? <ActivityIndicator style={styles.spinner} color={colors.ink} /> : null}{error && cursor ? <View style={styles.footerRetry}><Action label="重试加载更多" disabled={busy || loading} onPress={() => {load(cursor);}} /></View> : null}</View>}
      renderItem={({item}) => <View style={styles.item}>
        <View style={styles.identity}>
          <Preview key={`${item.id}-${previewRevision}`} api={api} item={item} />
          <View style={styles.copy}>
            <Text style={styles.name} numberOfLines={1}>{item.filename}</Text>
            <Text style={styles.meta} numberOfLines={1}>{item.folder_name} · {(item.size / 1024 / 1024).toFixed(1)} MB</Text>
            <Text style={styles.meta}>剩余 {Math.max(0, Math.ceil((Date.parse(item.expires_at) - Date.now()) / 86400000))} 天过期</Text>
          </View>
          {item.state === 'trashed' ? <Action label={selected.has(item.id) ? `取消选择 ${item.filename}` : `选择 ${item.filename}`} selected={selected.has(item.id)} disabled={busy || loading} onPress={() => toggle(item.id)} /> : null}
        </View>
        {item.state !== 'trashed' ? <View style={styles.pendingRow}>
          <Text style={styles.meta}>待处理：{({moving: '移入中', restoring: '恢复中', purging: '清理中'} as const)[item.state]}</Text>
          <Action label={`重试处理 ${item.filename}`} disabled={busy || loading} onPress={() => retry(item.id)} />
        </View> : null}
        {item.state === 'trashed' && item.recovery_required ? <View style={styles.pendingRow}><Action label={`重试处理 ${item.filename}`} disabled={busy || loading} onPress={() => retry(item.id)} /></View> : null}
      </View>} />
    {mode ? <Sheet title={mode === 'restore' ? '恢复照片' : mode === 'clear' ? '清空我的回收站？' : '永久删除？'} close={() => setMode(null)} busy={busy}>
      {mode === 'restore' ? <View style={styles.sheetGap}>
        <Text style={ui.copy}>默认恢复到原目录。原目录失效时请选择同一所有者的可写目录。</Text>
        <View style={ui.row}>
          <Action label={target ? `目标：${target.name}` : '恢复到原目录'} selected={!target} disabled={busy} onPress={() => setTarget(null)} />
          <Action label="选择其他目标目录" disabled={busy || owners.size !== 1} onPress={() => setChoosing(true)} />
        </View>
        <Action label={rename ? '同名时自动改名：开' : '同名时自动改名：关'} selected={rename} disabled={busy} onPress={() => setRename(value => !value)} />
      </View> : <Text style={ui.error}>{mode === 'clear' ? '永久删除我的回收站中本次确认前已删除的全部可清理内容，包括未加载的项目。' : `永久删除选中的 ${chosen.length} 项。`}此操作无法恢复。</Text>}
      <View style={styles.sheetFooter}>
        <Action label={mode === 'restore' ? '确认恢复' : '确认永久删除'} variant="primary" danger={mode !== 'restore'} disabled={busy} onPress={perform} />
      </View>
    </Sheet> : null}
    {choosing ? <FolderPicker api={api} ownerId={chosen[0]?.owner_id} close={() => setChoosing(false)} choose={folder => {setTarget(folder); setChoosing(false);}} /> : null}
  </View>;
}

const styles = StyleSheet.create({
  page: {flex: 1, backgroundColor: colors.paper},
  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8, height: 48},
  headerTitle: {fontSize: 17, fontWeight: '600', color: colors.ink},
  caption: {color: colors.muted, fontSize: 12, paddingHorizontal: 16, marginBottom: 8},
  toolbar: {flexGrow: 0, maxHeight: 46, marginBottom: 8},
  toolbarContent: {paddingHorizontal: 16, gap: 8, alignItems: 'center'},
  bannerError: {color: colors.danger, fontSize: 13, paddingHorizontal: 16, marginBottom: 6},
  bannerNotice: {color: colors.ink, fontSize: 13, paddingHorizontal: 16, marginBottom: 6},
  listContent: {paddingBottom: 24, borderTopWidth: hairline, borderTopColor: colors.hairline},
  empty: {color: colors.muted, fontSize: 14, textAlign: 'center', marginTop: 32},
  spinner: {marginVertical: 16},
  footerRetry: {alignItems: 'center', marginVertical: 12},
  item: {paddingHorizontal: 16, paddingVertical: 12, backgroundColor: colors.surface, borderBottomWidth: hairline, borderBottomColor: colors.hairline},
  identity: {flexDirection: 'row', alignItems: 'center', gap: 12},
  copy: {flex: 1},
  name: {color: colors.ink, fontSize: 14, fontWeight: '600'},
  meta: {color: colors.muted, fontSize: 12, marginTop: 3},
  pendingRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8},
  preview: {width: 54, height: 54, backgroundColor: colors.recessed, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, overflow: 'hidden'},
  previewFallback: {color: colors.muted, fontSize: 11},
  sheetGap: {gap: 8},
  sheetFooter: {marginTop: 14},
});
