import React, {useMemo, useRef, useState} from 'react';
import {Image, Linking, PanResponder, Pressable, StyleSheet, Text, View} from 'react-native';
import type {BrowseApi, MapConfig} from '../browse/api';
import MediaThumbnail from '../browse/MediaThumbnail';
import {Action, ui} from '../browse/ManagementUI';
import {PhotoClusters, type LocatedPhoto, type MarkerSpec} from './clusters';
import {project, tileURL, unproject, viewBounds, zoomLimits, type MapView, type Size} from './geometry';

type Props = {api: BrowseApi; config: MapConfig; photos: LocatedPhoto[]; view: MapView; change?: (view: MapView) => void;
  marker?: (spec: MarkerSpec, clusters: PhotoClusters) => void; layout?: (size: Size) => void; mini?: boolean};

export default function PhotoMap({api, config, photos, view, change, marker, layout, mini = false}: Props) {
  const [size, setSize] = useState<Size>({width: 320, height: mini ? 180 : 300});
  const [retry, setRetry] = useState(0);
  const [tilesFailed, setTilesFailed] = useState(false);
  const [attributionError, setAttributionError] = useState('');
  const limits = zoomLimits(config);
  const clusters = useMemo(() => new PhotoClusters(photos, limits.max), [photos, limits.max]);
  const bounds = viewBounds(view, size);
  const specs = clusters.markers(bounds, view.zoom, view.lng, mini ? 0 : 20);
  const center = project(view.lat, view.lng, view.zoom);
  const firstX = Math.floor((center.x - size.width / 2) / 256); const lastX = Math.floor((center.x + size.width / 2) / 256);
  const firstY = Math.max(0, Math.floor((center.y - size.height / 2) / 256)); const lastY = Math.min(2 ** view.zoom - 1, Math.floor((center.y + size.height / 2) / 256));
  const tiles: {key: string; uri: string; left: number; top: number}[] = [];
  for (const [index, layer] of (config.tile_layers ?? []).entries()) {
    for (let x = firstX; x <= lastX; x++) {
      for (let y = firstY; y <= lastY; y++) {
        tiles.push({key: `${index}-${view.zoom}-${x}-${y}-${retry}`, uri: tileURL(layer, x, y, view.zoom), left: x * 256 - center.x + size.width / 2, top: y * 256 - center.y + size.height / 2});
      }
    }
  }
  const signature = `${view.zoom}:${firstX}:${firstY}:${lastX}:${lastY}:${retry}`;
  const tileStatus = useRef({signature, loaded: 0, failed: 0});
  if (tileStatus.current.signature !== signature) {tileStatus.current = {signature, loaded: 0, failed: 0};}
  const latest = useRef({view, change, limits}); latest.current = {view, change, limits};
  const drag = useRef({view, distance: 0, dx: 0, dy: 0});
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (event, gesture) => !!latest.current.change && (event.nativeEvent.touches.length > 1 || Math.abs(gesture.dx) + Math.abs(gesture.dy) > 6),
    onPanResponderGrant: event => {
      const touches = event.nativeEvent.touches;
      drag.current = {view: latest.current.view, distance: touches.length > 1 ? Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY) : 0, dx: 0, dy: 0};
    },
    onPanResponderMove: (event, gesture) => {
      const touches = event.nativeEvent.touches; const start = drag.current;
      if (touches.length > 1) {
        const distance = Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY);
        if (!start.distance) {drag.current = {view: latest.current.view, distance, dx: gesture.dx, dy: gesture.dy}; return;}
        const zoom = Math.max(latest.current.limits.min, Math.min(latest.current.limits.max, Math.round(start.view.zoom + Math.log2(Math.max(1, distance) / start.distance))));
        latest.current.change?.({...start.view, zoom});
      } else {
        if (start.distance) {drag.current = {view: latest.current.view, distance: 0, dx: gesture.dx, dy: gesture.dy}; return;}
        const origin = project(start.view.lat, start.view.lng, start.view.zoom);
        latest.current.change?.({...unproject(origin.x - gesture.dx + start.dx, origin.y - gesture.dy + start.dy, start.view.zoom), zoom: start.view.zoom});
      }
    },
    onPanResponderTerminationRequest: () => false,
  }), []);
  const zoom = (delta: number) => change?.({...view, zoom: Math.max(limits.min, Math.min(limits.max, view.zoom + delta))});
  return <View style={[styles.map, mini && styles.mini]} onLayout={event => {
    const next = {width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height};
    if (next.width > 0 && next.height > 0 && (size.width !== next.width || size.height !== next.height)) {setSize(next); layout?.(next);}
  }}>
    <View style={StyleSheet.absoluteFill} {...(mini ? {} : pan.panHandlers)}>
      {tiles.map(tile => <Image key={tile.key} source={{uri: tile.uri}} style={[styles.tile, {left: tile.left, top: tile.top}]} onLoad={() => {
        if (tileStatus.current.signature === signature) {tileStatus.current.loaded++; setTilesFailed(false);}
      }} onError={() => {
        if (tileStatus.current.signature === signature && ++tileStatus.current.failed >= 4 && tileStatus.current.loaded === 0) {setTilesFailed(true);}
      }} />)}
      {specs.map(spec => {
        const point = project(spec.lat, spec.lng, view.zoom);
        const left = point.x - center.x + size.width / 2; const top = point.y - center.y + size.height / 2;
        return mini ? <View key={spec.key} style={[styles.pin, {left: left - 8, top: top - 8}]} /> :
          <Pressable key={spec.key} accessibilityRole="button" accessibilityLabel={spec.count > 1 ? `查看此地点 ${spec.count} 张照片` : '查看此地点照片'}
            onPress={() => marker?.(spec, clusters)} style={[styles.marker, {left: left - 24, top: top - 24}]}>
            {spec.thumbnail ? <MediaThumbnail api={api} id={spec.coverId} size={48} /> : null}
            <Text style={styles.count}>{spec.count > 1 ? spec.count : '●'}</Text>
          </Pressable>;
      })}
    </View>
    {!mini && change ? <View style={styles.controls}><Action label="放大地图" disabled={view.zoom >= limits.max} onPress={() => zoom(1)} /><Action label="缩小地图" disabled={view.zoom <= limits.min} onPress={() => zoom(-1)} /></View> : null}
    {tilesFailed ? <View style={styles.failure}><Text style={ui.error}>底图加载失败</Text><Action label="重试底图" onPress={() => {setRetry(value => value + 1); setTilesFailed(false);}} /></View> : null}
    {config.attribution ? <Pressable style={styles.attribution} accessibilityRole="link" accessibilityLabel={config.attribution} onPress={() => {
      if (config.attribution_url?.startsWith('https://')) {Linking.openURL(config.attribution_url).catch(() => setAttributionError('无法打开地图来源链接'));}
    }}><Text style={styles.attributionText}>{config.attribution}</Text></Pressable> : null}
    {attributionError ? <Text style={styles.attributionError}>{attributionError}</Text> : null}
  </View>;
}
const styles = StyleSheet.create({
  map: {height: 300, overflow: 'hidden', backgroundColor: '#E7EBE7', borderRadius: 16}, mini: {height: 180},
  tile: {position: 'absolute', width: 256, height: 256}, marker: {position: 'absolute', width: 48, height: 48, backgroundColor: '#3D4A5C', borderRadius: 9, justifyContent: 'center', alignItems: 'center'},
  count: {position: 'absolute', right: 0, bottom: 0, backgroundColor: '#3D4A5C', color: '#FFF', fontSize: 12, paddingHorizontal: 4, borderRadius: 4},
  pin: {position: 'absolute', width: 16, height: 16, borderRadius: 8, backgroundColor: '#A3372C', borderWidth: 2, borderColor: '#FFF'},
  controls: {position: 'absolute', right: 8, top: 8, backgroundColor: '#FFFE', borderRadius: 12},
  attribution: {position: 'absolute', bottom: 0, right: 0, backgroundColor: '#FFFD', minHeight: 32, paddingHorizontal: 8, justifyContent: 'center'}, attributionText: {fontSize: 11, color: '#3D4A5C'},
  attributionError: {position: 'absolute', bottom: 34, right: 8, color: '#A3372C', backgroundColor: '#FFF'},
  failure: {position: 'absolute', bottom: 34, left: 8, backgroundColor: '#FFFE', borderRadius: 10, paddingHorizontal: 8},
});
