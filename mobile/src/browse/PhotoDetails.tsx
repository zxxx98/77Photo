import React, {useEffect, useMemo, useState, useSyncExternalStore} from 'react';
import {ActivityIndicator, Linking, StyleSheet, Text, View} from 'react-native';
import {BrowseApi, type MapConfig, type Photo} from './api';
import {Action, Sheet, ui} from './ManagementUI';
import {operationError} from './management';
import PhotoMap from '../map/PhotoMap';
import {zoomLimits, type MapFocus} from '../map/geometry';
import {colors, hairline, radius} from '../ui/theme';

export function photoLocation(photo: Photo): {lat: number; lng: number} | null {
  const lat = photo.gps_latitude; const lng = photo.gps_longitude;
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? {lat, lng} : null;
}
export function amapURL(lat: number, lng: number): string {
  return `https://uri.amap.com/marker?position=${lng.toFixed(6)},${lat.toFixed(6)}&coordinate=wgs84&callnative=1`;
}

function DetailRow({label, value, first = false, selectable = false}: {label: string; value: string; first?: boolean; selectable?: boolean}) {
  return <View style={[styles.detailRow, !first && styles.rowDivider]}>
    <Text style={styles.detailLabel}>{label}</Text>
    <Text selectable={selectable} style={styles.detailValue}>{value}</Text>
  </View>;
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
  const specs = [
    {label: '拍摄时间', value: photo.captured_at.replace('T', ' ')},
    {label: '所在文件夹', value: folderName || '未知目录'},
    {label: '文件大小', value: `${(photo.size / 1024 / 1024).toFixed(2)} MB`},
    ...(photo.width && photo.height ? [{label: '尺寸：', value: `${photo.width} × ${photo.height}`}] : []),
    ...(camera ? [{label: '相机', value: camera}] : []),
    ...(photo.focal_length ? [{label: '焦距', value: `${photo.focal_length} mm`}] : []),
    ...(photo.aperture ? [{label: '光圈', value: `f/${photo.aperture}`}] : []),
    ...(photo.iso ? [{label: 'ISO', value: `${photo.iso}`}] : []),
    ...(location ? [{label: 'GPS', value: `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}`, selectable: true}] : []),
  ];
  return <Sheet title="照片详情" close={close}>
    <Text selectable style={styles.filename}>{photo.filename}</Text>
    <View style={styles.group}>
      {specs.map((entry, index) => <DetailRow key={entry.label} label={entry.label} value={entry.value} first={index === 0} selectable={entry.selectable} />)}
    </View>
    {location ? <View style={styles.locationBlock}>
      {config?.enabled ? <>
        <PhotoMap api={api} config={config} photos={points} view={{...location, zoom: Math.max(zoomLimits(config).min, Math.min(14, zoomLimits(config).max))}} mini />
        <View style={styles.locationActions}>
          <Action label="在地图相册中查看" variant="primary" onPress={() => {close(); onMap({...location, zoom: 16});}} />
          <Action label="在高德地图中打开" onPress={() => {setLinkError(''); Linking.openURL(amapURL(location.lat, location.lng)).catch(() => setLinkError('无法打开高德地图，请检查设备是否可以打开网页'));}} />
        </View>
      </> : !config && !error ? <ActivityIndicator style={styles.spinner} color={colors.ink} /> :
        <View style={styles.locationActions}>
          <Action label="在高德地图中打开" onPress={() => {setLinkError(''); Linking.openURL(amapURL(location.lat, location.lng)).catch(() => setLinkError('无法打开高德地图，请检查设备是否可以打开网页'));}} />
        </View>}
      {error ? <View style={styles.errorRow}><Text accessibilityRole="alert" style={ui.error}>{error}</Text><Action label="重试位置地图" onPress={() => setAttempt(value => value + 1)} /></View> : null}
      {linkError ? <Text accessibilityRole="alert" style={ui.error}>{linkError}</Text> : null}
    </View> : <Text style={ui.copy}>此照片没有有效的位置信息</Text>}
  </Sheet>;
}

const styles = StyleSheet.create({
  filename: {color: colors.ink, fontSize: 16, fontWeight: '600', marginTop: 4, marginBottom: 12},
  group: {backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden', marginBottom: 12},
  detailRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 11, gap: 12},
  rowDivider: {borderTopWidth: hairline, borderTopColor: colors.hairline},
  detailLabel: {color: colors.muted, fontSize: 13},
  detailValue: {color: colors.ink, fontSize: 13, fontWeight: '500', textAlign: 'right', flexShrink: 1},
  locationBlock: {gap: 10},
  locationActions: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  spinner: {marginVertical: 12},
  errorRow: {gap: 6},
});
