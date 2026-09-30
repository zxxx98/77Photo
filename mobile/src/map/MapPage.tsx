import React, {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {ActivityIndicator, BackHandler, FlatList, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {BrowseApi, type BBox, type MapConfig, type Photo} from '../browse/api';
import {Action, ui} from '../browse/ManagementUI';
import MediaThumbnail from '../browse/MediaThumbnail';
import {operationError} from '../browse/management';
import {usePhotos} from '../browse/usePhotos';
import PhotoMap from './PhotoMap';
import {countInBBox, filterByYear, placeBBox, toLocatedPhotos, yearRange, yearsOf, type LocatedPhoto, type MarkerSpec, type PhotoClusters} from './clusters';
import {fitPhotos, viewBounds, zoomLimits, type MapFocus, type MapView, type Size} from './geometry';

type Scope = {kind: 'area' | 'place'; bbox: BBox; count?: number};
export default function MapPage({api, close, open, focus}: {api: BrowseApi; close: () => void; open: (photo: Photo, all: Photo[]) => void; focus?: MapFocus}) {
  const revision = useSyncExternalStore(api.subscribe, api.getRevision);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [error, setError] = useState('');
  const [config, setConfig] = useState<MapConfig>({enabled: false});
  const [located, setLocated] = useState<LocatedPhoto[]>([]);
  const [total, setTotal] = useState(0);
  const [year, setYear] = useState<number | null>(null);
  const [view, setView] = useState<MapView>(focus ?? {lat: 35, lng: 105, zoom: 4});
  const [size, setSize] = useState<Size>({width: 320, height: 300});
  const [scope, setScope] = useState<Scope | null>(null);
  const [opening, setOpening] = useState(false);
  const initialized = useRef(false);
  const generation = useRef(0);
  const openGeneration = useRef(0);
  const mounted = useRef(true);
  const areaTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const invalidate = useCallback(() => {generation.current++;}, []);
  const load = useCallback(async () => {
    const ticket = ++generation.current; setStatus('loading'); setError('');
    try {
      const [nextConfig, points] = await Promise.all([api.mapConfig(), api.mapPoints()]);
      if (ticket !== generation.current) {return;}
      setConfig(nextConfig); setLocated(toLocatedPhotos(points.items)); setTotal(points.total_photos); setStatus('ready');
    } catch (e) {if (ticket === generation.current) {setError(operationError(e)); setStatus('failed');}}
  }, [api]);
  useEffect(() => {load(); return invalidate;}, [load, revision, invalidate]);
  useEffect(() => {
    initialized.current = false; setYear(null); setScope(null);
  }, [focus]);
  useEffect(() => {
    if (status !== 'ready' || !config.enabled || initialized.current) {return;}
    initialized.current = true;
    const limits = zoomLimits(config);
    setView(focus ? {...focus, zoom: Math.max(limits.min, Math.min(limits.max, focus.zoom))} : fitPhotos(located, size, limits.min, Math.min(12, limits.max)));
  }, [status, config, focus, located, size]);
  const filtered = useMemo(() => filterByYear(located, year), [located, year]);
  const years = useMemo(() => yearsOf(located), [located]);
  useEffect(() => {
    if (status !== 'ready' || !config.enabled) {return;}
    areaTimer.current = setTimeout(() => setScope({kind: 'area', bbox: viewBounds(view, size)}), 250);
    const timer = areaTimer.current;
    return () => clearTimeout(timer);
  }, [status, config.enabled, view, size]);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  useEffect(() => {const back = BackHandler.addEventListener('hardwareBackPress', () => {close(); return true;}); return () => back.remove();}, [close]);
  const page = usePhotos(api, undefined, false, {...(scope ? {bbox: scope.bbox} : {}), ...(year === null ? {} : yearRange(year))}, status === 'ready' && config.enabled && !!scope);
  async function marker(spec: MarkerSpec, clusters: PhotoClusters) {
    setError(''); clearTimeout(areaTimer.current);
    if (spec.clusterId !== undefined) {
      const zoom = clusters.expansionZoom(spec.clusterId);
      if (zoom <= zoomLimits(config).max && view.zoom < zoomLimits(config).max) {setView({lat: spec.lat, lng: spec.lng, zoom});}
      else {
        const leaves = clusters.leaves(spec.clusterId); const bbox = placeBBox(leaves);
        if (bbox) {setScope({kind: 'place', bbox, count: leaves.length});}
      }
      return;
    }
    const ticket = ++openGeneration.current; setOpening(true);
    try {const photo = await api.photo(spec.coverId); if (mounted.current && ticket === openGeneration.current) {open(photo, [photo]);}}
    catch (e) {if (mounted.current && ticket === openGeneration.current) {setError(operationError(e));}}
    finally {if (mounted.current && ticket === openGeneration.current) {setOpening(false);}}
  }
  function chooseYear(value: number | null) {
    if (year === value) {return;}
    setYear(value);
    const photos = filterByYear(located, value);
    if (photos.length && countInBBox(photos, viewBounds(view, size)) === 0) {
      const limits = zoomLimits(config); setView(fitPhotos(photos, size, limits.min, Math.min(12, limits.max)));
    }
    setScope({kind: 'area', bbox: viewBounds(view, size)});
  }
  return <View style={styles.page}>
    <View style={ui.row}><Action label="返回图库" onPress={close} /><Text style={ui.heading}>地图相册</Text><Action label="刷新地图" disabled={status === 'loading'} onPress={load} /></View>
    {status === 'loading' ? <ActivityIndicator /> : null}
    {error ? <Text accessibilityRole="alert" style={ui.error}>{error}</Text> : null}
    {status === 'failed' ? <Action label="重试地图" onPress={load} /> : status === 'ready' && !config.enabled ? <Text style={ui.copy}>服务器尚未启用地图，请由管理员在 Web 设置中配置地图。</Text> : status === 'ready' ? <>
      <Text style={ui.copy}>{located.length} / {total} 项媒体带有位置{located.length === 0 ? '，目前没有可显示的照片' : ''}</Text>
      <ScrollView horizontal style={styles.years} contentContainerStyle={ui.row}><Action label="全部年份" selected={year === null} onPress={() => chooseYear(null)} />{years.map(value => <Action key={value} label={`${value} 年`} selected={year === value} onPress={() => chooseYear(value)} />)}</ScrollView>
      <PhotoMap api={api} config={config} photos={filtered} view={view} change={setView} marker={marker} layout={setSize} />
      <View style={ui.row}><Text style={ui.copy}>{scope?.kind === 'place' ? `此地点 · ${scope.count} 张照片` : '当前区域照片'}</Text>{scope?.kind === 'place' ? <Action label="返回当前区域" onPress={() => setScope({kind: 'area', bbox: viewBounds(view, size)})} /> : null}</View>
      {opening ? <ActivityIndicator /> : null}
      {page.state === 'loading' ? <ActivityIndicator /> : page.state === 'empty' ? <Text style={ui.copy}>此区域没有匹配的照片</Text> : page.state !== 'ready' ? <><Text style={ui.error}>{page.state === 'forbidden' ? '没有查看权限' : page.state === 'expired' ? '登录已失效' : '区域照片加载失败'}</Text><Action label="重试区域照片" onPress={page.refresh} /></> : null}
      <FlatList data={page.items} keyExtractor={photo => photo.id} numColumns={3}
        onEndReached={() => {if (page.cursor && page.moreState === 'ready') {page.loadMore();}}} onEndReachedThreshold={0.4}
        ListFooterComponent={page.moreState === 'loading' ? <ActivityIndicator /> : page.moreState !== 'ready' ? <Action label="重试更多区域照片" onPress={page.loadMore} /> : undefined}
        renderItem={({item}) => <Pressable style={styles.photo} accessibilityRole="button" accessibilityLabel={`查看 ${item.filename}`} onPress={() => open(item, page.items)}><MediaThumbnail api={api} id={item.id} size={88} /><Text numberOfLines={1} style={styles.name}>{item.filename}</Text></Pressable>} />
    </> : null}
  </View>;
}
const styles = StyleSheet.create({page: {flex: 1, padding: 12, backgroundColor: '#FAF9F7'}, years: {maxHeight: 48, flexGrow: 0, marginBottom: 8}, photo: {flex: 1, alignItems: 'center', marginVertical: 5, minWidth: 0}, name: {fontSize: 11, color: '#75808A', maxWidth: 90, marginTop: 4}});
