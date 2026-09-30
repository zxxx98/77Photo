import React, {useEffect, useMemo, useState, useSyncExternalStore} from 'react';
import {ActivityIndicator, Linking, Text, View} from 'react-native';
import {BrowseApi, type MapConfig, type Photo} from './api';
import {Action, Sheet, ui} from './ManagementUI';
import {operationError} from './management';
import PhotoMap from '../map/PhotoMap';
import {zoomLimits, type MapFocus} from '../map/geometry';

export function photoLocation(photo: Photo): {lat: number; lng: number} | null {
  const lat = photo.gps_latitude; const lng = photo.gps_longitude;
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? {lat, lng} : null;
}
export function amapURL(lat: number, lng: number): string {
  return `https://uri.amap.com/marker?position=${lng.toFixed(6)},${lat.toFixed(6)}&coordinate=wgs84&callnative=1`;
}
export default function PhotoDetails({api, photo, folderName, close, onMap}: {
  api: BrowseApi; photo: Photo; folderName: string; close: () => void; onMap: (focus: MapFocus) => void;
}) {
  const revision = useSyncExternalStore(api.subscribe, api.getRevision);
  const location = useMemo(() => photoLocation(photo), [photo]);
  const hasLocation = location !== null;
  const [config, setConfig] = useState<MapConfig | null>(null);
  const [error, setError] = useState('');
  const [linkError, setLinkError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true; setConfig(null); setError('');
    if (hasLocation) {api.mapConfig().then(value => {if (active) {setConfig(value);}}).catch(e => {if (active) {setError(operationError(e));}});}
    return () => {active = false;};
  }, [api, hasLocation, attempt, revision]);
  const points = useMemo(() => location ? [{id: photo.id, lat: location.lat, lng: location.lng, capturedAt: photo.captured_at}] : [], [location, photo.id, photo.captured_at]);
  const camera = [photo.camera_make, photo.camera_model].filter(Boolean).join(' ');
  return <Sheet title="照片详情" close={close}>
    <Text selectable style={ui.heading}>{photo.filename}</Text>
    <Text style={ui.copy}>拍摄时间：{photo.captured_at.replace('T', ' ')}</Text>
    <Text style={ui.copy}>所在文件夹：{folderName || '未知目录'}</Text>
    <Text style={ui.copy}>文件大小：{(photo.size / 1024 / 1024).toFixed(2)} MB</Text>
    {photo.width && photo.height ? <Text style={ui.copy}>尺寸：{photo.width} × {photo.height}</Text> : null}
    {camera ? <Text style={ui.copy}>相机：{camera}</Text> : null}
    {photo.focal_length ? <Text style={ui.copy}>焦距：{photo.focal_length} mm</Text> : null}
    {photo.aperture ? <Text style={ui.copy}>光圈：f/{photo.aperture}</Text> : null}
    {photo.iso ? <Text style={ui.copy}>ISO：{photo.iso}</Text> : null}
    {location ? <View>
      <Text selectable style={ui.copy}>GPS：{location.lat.toFixed(6)}, {location.lng.toFixed(6)}</Text>
      {config?.enabled ? <><PhotoMap api={api} config={config} photos={points} view={{...location, zoom: Math.max(zoomLimits(config).min, Math.min(14, zoomLimits(config).max))}} mini />
        <Action label="在地图相册中查看" onPress={() => {close(); onMap({...location, zoom: 16});}} /></> : !config && !error ? <ActivityIndicator /> : null}
      {error ? <><Text accessibilityRole="alert" style={ui.error}>{error}</Text><Action label="重试位置地图" onPress={() => setAttempt(value => value + 1)} /></> : null}
      <Action label="在高德地图中打开" onPress={() => {setLinkError(''); Linking.openURL(amapURL(location.lat, location.lng)).catch(() => setLinkError('无法打开高德地图，请检查设备是否可以打开网页'));}} />
      {linkError ? <Text accessibilityRole="alert" style={ui.error}>{linkError}</Text> : null}
    </View> : <Text style={ui.copy}>此照片没有有效的位置信息</Text>}
  </Sheet>;
}
