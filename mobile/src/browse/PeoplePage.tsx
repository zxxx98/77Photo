import React, {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {ActivityIndicator, BackHandler, FlatList, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {ApiError} from '../auth/api';
import {BrowseApi, type Face, type FacePage, type Person, type Photo} from './api';
import {Action, Sheet, ui} from './ManagementUI';
import MediaThumbnail from './MediaThumbnail';
import {operationError} from './management';

function label(person: Person) {return person.name || `未命名人物 · ${person.id.slice(-6)}`;}

function usePages<T extends {id: string}>(fetchPage: (cursor?: string) => Promise<FacePage<T>>, revision: number) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const running = useRef(false);
  const invalidate = useCallback(() => {generation.current++; running.current = false;}, []);
  const load = useCallback(async (next?: string) => {
    if (next && running.current) {return;}
    const ticket = ++generation.current; running.current = true; setLoading(true); setError('');
    if (!next) {setItems([]); setCursor('');}
    try {
      const page = await fetchPage(next);
      if (ticket !== generation.current) {return;}
      setItems(old => next ? [...old, ...page.items.filter(item => !old.some(existing => existing.id === item.id))] : page.items); setCursor(page.next_cursor);
    } catch (e) {if (ticket === generation.current) {setError(operationError(e));}}
    finally {if (ticket === generation.current) {running.current = false; setLoading(false);}}
  }, [fetchPage]);
  useEffect(() => {load(); return invalidate;}, [load, revision, invalidate]);
  return {items, setItems, cursor, loading, error, load};
}

function PersonPhotos({api, person, close, rename, open}: {api: BrowseApi; person: Person; close: () => void; rename: () => void; open: (photo: Photo, all: Photo[]) => void}) {
  const revision = useSyncExternalStore(api.subscribe, api.getRevision);
  const fetchPage = useCallback((cursor?: string) => api.personFaces(person.id, cursor), [api, person.id]);
  const page = usePages<Face>(fetchPage, revision);
  // Multiple face detections may refer to the same photo, including across pages.
  const photos = useMemo(() => {const seen = new Set<string>(); return page.items.filter(face => {if (seen.has(face.photo_id)) {return false;} seen.add(face.photo_id); return true;});}, [page.items]);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const openingRef = useRef(false);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  async function viewPhoto(id: string) {
    if (openingRef.current) {return;}
    openingRef.current = true; setOpening(true); setError('');
    try {const photo = await api.photo(id); if (mounted.current) {open(photo, [photo]);}}
    catch (e) {if (mounted.current) {setError(operationError(e));}}
    finally {openingRef.current = false; if (mounted.current) {setOpening(false);}}
  }
  return <View style={styles.page}>
    <View style={ui.row}><Action label="返回人物列表" onPress={close} /><Text style={ui.heading}>{label(person)}</Text><Action label="人物命名" onPress={rename} /></View>
    <View style={ui.row}><Text style={ui.copy}>{person.photo_count} 张照片</Text><Action label="刷新人物照片" disabled={page.loading} onPress={() => page.load()} /></View>
    {page.error || error ? <Text accessibilityRole="alert" style={ui.error}>{page.error || error}</Text> : null}
    {page.error ? <Action label="重试人物照片" onPress={() => page.load(page.cursor || undefined)} /> : null}
    {page.loading || opening ? <ActivityIndicator /> : null}
    <FlatList data={photos} keyExtractor={face => face.photo_id} numColumns={3}
      onEndReached={() => {if (page.cursor && !page.loading) {page.load(page.cursor);}}} onEndReachedThreshold={0.4}
      ListEmptyComponent={!page.loading && !page.error ? <Text style={ui.copy}>此人物还没有可查看的照片</Text> : undefined}
      ListFooterComponent={page.cursor ? <Action label="加载更多人物照片" disabled={page.loading} onPress={() => page.load(page.cursor)} /> : undefined}
      renderItem={({item}) => <Pressable style={styles.photo} accessibilityRole="button" accessibilityLabel={`查看 ${item.filename}`} disabled={opening} onPress={() => viewPhoto(item.photo_id)}>
        <MediaThumbnail api={api} id={item.photo_id} size={88} /><Text numberOfLines={1} style={styles.filename}>{item.filename}</Text>
      </Pressable>} />
  </View>;
}

export default function PeoplePage({api, close, open}: {api: BrowseApi; close: () => void; open: (photo: Photo, all: Photo[]) => void}) {
  const revision = useSyncExternalStore(api.subscribe, api.getRevision);
  const [availability, setAvailability] = useState<'loading' | 'ready' | 'disabled' | 'forbidden' | 'failed'>('loading');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Person | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [retry, setRetry] = useState(0);
  const fetchPeople = useCallback(async (cursor?: string): Promise<FacePage<Person>> => {
    if (availability !== 'ready') {return {items: [], next_cursor: ''};}
    return api.people(cursor);
  }, [api, availability]);
  const page = usePages(fetchPeople, revision);
  useEffect(() => {
    let active = true; setAvailability('loading'); setError('');
    api.me().then(async me => {
      if (me.role !== 'admin') {return 'forbidden' as const;}
      const config = await api.faceConfig(); return config.enabled ? 'ready' as const : 'disabled' as const;
    }).then(state => {if (active) {setAvailability(state);}})
      .catch(e => {if (active) {setError(operationError(e)); setAvailability(e instanceof ApiError && e.status === 403 ? 'forbidden' : 'failed');}});
    return () => {active = false;};
  }, [api, revision, retry]);
  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {if (selected) {setSelected(null);} else {close();} return true;});
    return () => back.remove();
  }, [selected, close]);
  // Refresh metadata for a selected person after returning from the viewer.
  useEffect(() => {
    if (!selected) {return;}
    const current = page.items.find(person => person.id === selected.id);
    if (current && current.revision !== selected.revision) {setSelected(current);}
  }, [page.items, selected]);
  async function saveName() {
    if (!selected || saving.current) {return;}
    saving.current = true; setBusy(true); setError('');
    try {
      await api.renamePerson(selected, name.trim());
      const updated = {...selected, name: name.trim(), revision: selected.revision + 1};
      page.setItems(old => old.map(person => person.id === updated.id ? updated : person)); setSelected(updated); setNaming(false);
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'FACE_CONFLICT' ? '人物已被其他操作修改，请关闭命名面板，刷新人物列表后重试' : operationError(e));
    } finally {saving.current = false; setBusy(false);}
  }
  if (availability !== 'ready') {return <View style={styles.page}>
    <View style={ui.row}><Action label="返回图库" onPress={close} /><Text style={ui.heading}>人物相册</Text></View>
    {availability === 'loading' ? <ActivityIndicator /> : <Text accessibilityRole={availability === 'failed' ? 'alert' : 'text'} style={ui.copy}>{availability === 'disabled' ? '服务器尚未启用人脸识别，请由管理员在 Web 设置中配置。' : availability === 'forbidden' ? '当前人物功能仅对管理员开放' : error || '人物加载失败'}</Text>}
    {availability === 'failed' ? <Action label="重试人物相册" onPress={() => setRetry(value => value + 1)} /> : null}
  </View>;}
  return <View style={styles.page}>
    {selected ? <PersonPhotos key={selected.id} api={api} person={selected} close={() => {setSelected(null); setError('');}} rename={() => {setName(selected.name); setError(''); setNaming(true);}} open={open} /> : <>
      <View style={ui.row}><Action label="返回图库" onPress={close} /><Text style={ui.heading}>人物相册</Text><Action label="刷新人物列表" disabled={page.loading} onPress={() => page.load()} /></View>
      {page.error ? <><Text accessibilityRole="alert" style={ui.error}>{page.error}</Text><Action label="重试人物列表" onPress={() => page.load(page.cursor || undefined)} /></> : null}
      {page.loading ? <ActivityIndicator /> : null}
      <FlatList data={page.items} keyExtractor={person => person.id} numColumns={2}
        onEndReached={() => {if (page.cursor && !page.loading) {page.load(page.cursor);}}} onEndReachedThreshold={0.4}
        ListEmptyComponent={!page.loading && !page.error ? <Text style={ui.copy}>还没有识别出人物，可在 Web 中运行人脸扫描。</Text> : undefined}
        ListFooterComponent={page.cursor ? <Action label="加载更多人物" disabled={page.loading} onPress={() => page.load(page.cursor)} /> : undefined}
        renderItem={({item}) => <Pressable accessibilityRole="button" accessibilityLabel={`查看人物 ${label(item)}`} style={styles.person} onPress={() => {setSelected(item); setError('');}}>
          <MediaThumbnail api={api} id={item.cover_face_id} face size={108} /><Text style={styles.name}>{label(item)}</Text><Text style={ui.copy}>{item.photo_count} 张照片</Text>
        </Pressable>} />
    </>}
    {naming ? <Sheet title="人物命名" close={() => setNaming(false)} busy={busy}>
      <TextInput accessibilityLabel="人物名称" value={name} onChangeText={setName} editable={!busy} maxLength={80} autoFocus style={ui.input} placeholder="留空可恢复未命名" />
      {error ? <Text accessibilityRole="alert" style={ui.error}>{error}</Text> : null}
      <Action label="保存人物名称" disabled={busy || name.trim() === selected?.name} onPress={saveName} />
    </Sheet> : null}
  </View>;
}
const styles = StyleSheet.create({page: {flex: 1, padding: 12, backgroundColor: '#FAF9F7'}, person: {flex: 1, alignItems: 'center', padding: 12, margin: 4, borderRadius: 16, backgroundColor: '#FFF'}, name: {fontSize: 15, color: '#3D4A5C', fontWeight: '600', marginTop: 8}, photo: {flex: 1, alignItems: 'center', paddingVertical: 8}, filename: {fontSize: 11, color: '#75808A', maxWidth: 90, marginTop: 4}});
