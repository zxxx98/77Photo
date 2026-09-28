import React, {useEffect, useState} from 'react';
import {AppState, StyleSheet, Switch, Text, View} from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import type {MobileSession} from '../auth/session';
import type {BrowseApi, Folder} from '../browse/api';
import {bindBackup, configureBackup, readBackup, requestPhotoAccess, restoreBackupSchedule, runBackup, subscribeBackup, type BackupSettings as Settings} from './service';

type Props = {session: MobileSession; api: BrowseApi; folder: Folder | null};
export default function BackupSettings({session, api, folder}: Props) {
  const [settings, setSettings] = useState<Settings>({enabled: false, wifiOnly: true, folder: null});
  const [message, setMessage] = useState('');
  const [lastRun, setLastRun] = useState<string>();
  const [completed, setCompleted] = useState(0);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    const refresh = () => readBackup(session).then(record => {
      if (live) {setSettings(record.settings); setMessage(record.message ?? ''); setLastRun(record.lastRun); setCompleted(Object.keys(record.completed).length); setReady(true);}
    }).catch(() => {if (live) {setMessage('无法读取备份设置');}});
    const run = () => {runBackup(session, api).catch(() => {if (live) {setMessage('无法保存备份记录，请检查设备存储空间');}});};
    const unbind = bindBackup(api, session);
    const unsubscribe = subscribeBackup(() => {refresh();});
    refresh().then(() => restoreBackupSchedule(session)).then(run).catch(() => {if (live) {setMessage('无法恢复后台任务，请关闭后重新开启自动备份');}});
    const app = AppState.addEventListener('change', state => {if (state === 'active') {run();}});
    const network = NetInfo.addEventListener(() => {run();});
    const timer = setInterval(run, 60000);
    return () => {live = false; unbind(); unsubscribe(); app.remove(); network(); clearInterval(timer);};
  }, [api, session.profile?.id, session.server, session.username]); // eslint-disable-line react-hooks/exhaustive-deps

  async function change(next: Settings) {
    setBusy(true);
    try {
      if (next.enabled) {
        if (!next.folder) {throw new Error('请先选择服务器目标文件夹');}
        await requestPhotoAccess();
      }
      await configureBackup(session, next);
      setSettings(next);
      runBackup(session, api).catch(() => setMessage('无法保存备份记录，请检查设备存储空间'));
    } catch (error) {setMessage(error instanceof Error ? error.message : '无法更新备份设置');}
    finally {setBusy(false);}
  }
  return <View style={styles.card}>
    <View style={styles.row}><Text style={styles.title}>自动备份照片</Text><Switch accessibilityLabel="自动备份照片" value={settings.enabled} disabled={busy || !ready} onValueChange={enabled => change({...settings, enabled, folder: enabled ? folder ?? settings.folder : settings.folder})} /></View>
    <Text style={styles.detail}>开启后备份系统相册中的全部照片及后续新增照片。后台由系统定期执行；强行停止应用后需重新打开。</Text>
    <Text style={styles.detail}>备份到：{settings.folder?.name ?? '开启时使用下方所选文件夹'}。更改目录请先关闭再开启。</Text>
    <View style={styles.row}><Text style={styles.label}>仅 Wi-Fi</Text><Switch accessibilityLabel="仅 Wi-Fi 自动备份" value={settings.wifiOnly} disabled={busy || !ready} onValueChange={wifiOnly => change({...settings, wifiOnly})} /></View>
    <Text style={styles.detail}>已备份 {completed} 张{lastRun ? ` · 最近检查 ${new Date(lastRun).toLocaleString()}` : ''}</Text>
    {message ? <Text accessibilityLiveRegion="polite" style={styles.detail}>{message}</Text> : null}
  </View>;
}
const styles = StyleSheet.create({
  card: {marginHorizontal: 16, marginTop: 12, padding: 14, borderRadius: 16, backgroundColor: '#FFF'},
  row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  title: {fontSize: 16, fontWeight: '600', color: '#3D4A5C'}, label: {fontSize: 14, color: '#3D4A5C'},
  detail: {fontSize: 12, lineHeight: 18, color: '#75808A', marginTop: 4},
});
