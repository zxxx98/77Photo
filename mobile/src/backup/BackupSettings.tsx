import React, {useEffect, useState} from 'react';
import {AppState, Pressable, StyleSheet, Switch, Text, View} from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import type {MobileSession} from '../auth/session';
import type {BrowseApi, Folder} from '../browse/api';
import {bindBackup, cancelVisibleBackup, configureBackup, isVisibleBackupRunning, pauseVisibleBackup, readBackup, requestMediaAccess,
  restoreBackupSchedule, retryBlockedBackup, runBackup, runVisibleBackup, subscribeBackup, type BackupSettings as Settings} from './service';

type Props = {session: MobileSession; api: BrowseApi; folder: Folder | null};
export default function BackupSettings({session, api, folder}: Props) {
  const [settings, setSettings] = useState<Settings>({enabled: false, videoEnabled: false, wifiOnly: true, folder: null});
  const [message, setMessage] = useState('');
  const [lastRun, setLastRun] = useState<string>();
  const [lastVideoRun, setLastVideoRun] = useState<string>();
  const [completed, setCompleted] = useState({photo: 0, video: 0});
  const [blocked, setBlocked] = useState(0);
  const [targetBlocked, setTargetBlocked] = useState(false);
  const [pendingVideo, setPendingVideo] = useState(false);
  const [visibleActive, setVisibleActive] = useState(false);
  const [startingVisible, setStartingVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    const refresh = () => readBackup(session).then(record => {
      if (live) {
        setSettings(record.settings); setMessage(record.message ?? ''); setLastRun(record.lastRun); setLastVideoRun(record.lastVideoRun);
        const keys = Object.keys(record.completed);
        setCompleted({photo: keys.filter(key => !key.startsWith('video:')).length, video: keys.filter(key => key.startsWith('video:')).length});
        setBlocked(Object.keys(record.blocked ?? {}).length);
        setTargetBlocked(!!record.targetBlocked);
        setPendingVideo(!!record.pendingForegroundVideo);
        setVisibleActive(isVisibleBackupRunning());
        if (isVisibleBackupRunning()) {setStartingVisible(false);}
        setReady(true);
      }
    }).catch(() => {if (live) {setMessage('无法读取备份设置');}});
    const run = () => {runBackup(session, api).catch(() => {if (live) {setMessage('无法保存备份记录，请检查设备存储空间');}});};
    const unbind = bindBackup(api, session);
    const unsubscribe = subscribeBackup(() => {refresh();});
    refresh().then(() => restoreBackupSchedule(session)).then(run).catch(() => {if (live) {setMessage('无法恢复后台任务，请关闭后重新开启自动备份');}});
    const app = AppState.addEventListener('change', state => {if (state === 'active') {run();}});
    const network = NetInfo.addEventListener(() => {run();});
    const timer = setInterval(run, 60000);
    return () => {live = false; unbind(); unsubscribe(); app.remove(); network(); clearInterval(timer);};
  }, [api, session.profile?.id, session.server, session.userId, session.username]); // eslint-disable-line react-hooks/exhaustive-deps

  async function change(next: Settings) {
    setBusy(true);
    try {
      if (next.enabled || next.videoEnabled) {
        if (!next.folder) {throw new Error('请先选择服务器目标文件夹');}
        if (next.enabled && !settings.enabled) {await requestMediaAccess('photo');}
        if (next.videoEnabled && !settings.videoEnabled) {await requestMediaAccess('video');}
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
    <View style={styles.row}><Text style={styles.title}>备份视频</Text><Switch accessibilityLabel="备份视频" value={!!settings.videoEnabled} disabled={busy || !ready} onValueChange={videoEnabled => change({...settings, videoEnabled, folder: videoEnabled ? folder ?? settings.folder : settings.folder})} /></View>
    <Text style={styles.detail}>默认关闭。开启后扫描现有及新增的 MP4、WebM；超过 128 MB 的视频等待你启动可见传输，其他格式会显示未完成原因。</Text>
    {settings.videoEnabled ? visibleActive ? <View style={styles.row}>
      <Pressable accessibilityRole="button" onPress={() => pauseVisibleBackup().catch(error => setMessage(error instanceof Error ? error.message : '暂停失败'))}><Text style={styles.retry}>暂停视频传输</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={() => cancelVisibleBackup().catch(error => setMessage(error instanceof Error ? error.message : '取消失败'))}><Text style={styles.retry}>取消本次传输</Text></Pressable>
    </View> : <Pressable accessibilityRole="button" disabled={busy || startingVisible} onPress={() => {
      setStartingVisible(true);
      runVisibleBackup(session, api).catch(error => setMessage(error instanceof Error ? error.message : '无法启动可见视频传输'))
        .finally(() => setStartingVisible(false));
    }}><Text style={styles.retry}>{pendingVideo ? '继续待处理视频' : '开始可见视频传输'}</Text></Pressable> : null}
    {settings.videoEnabled ? <Text style={styles.detail}>可见传输会显示系统通知，可从通知暂停或取消。</Text> : null}
    <Text style={styles.detail}>备份到：{settings.folder?.name ?? '开启时使用下方所选文件夹'}。更改目录请先关闭再开启。</Text>
    <View style={styles.row}><Text style={styles.label}>仅 Wi-Fi</Text><Switch accessibilityLabel="仅 Wi-Fi 自动备份" value={settings.wifiOnly} disabled={busy || !ready} onValueChange={wifiOnly => change({...settings, wifiOnly})} /></View>
    <Text style={styles.detail}>已确认 {completed.photo} 张照片、{completed.video} 个视频</Text>
    {lastRun ? <Text style={styles.detail}>照片最近完整检查：{new Date(lastRun).toLocaleString()}</Text> : null}
    {lastVideoRun ? <Text style={styles.detail}>视频最近完整检查：{new Date(lastVideoRun).toLocaleString()}</Text> : null}
    {blocked > 0 || targetBlocked ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => {
      setBusy(true);
      retryBlockedBackup(session).then(() => runBackup(session, api)).catch(error => setMessage(error instanceof Error ? error.message : '重新检查失败'))
        .finally(() => setBusy(false));
    }}><Text style={styles.retry}>重新检查{targetBlocked ? '目标文件夹' : `${blocked} 项未完成媒体`}</Text></Pressable> : null}
    {message ? <Text accessibilityLiveRegion="polite" style={styles.detail}>{message}</Text> : null}
  </View>;
}
const styles = StyleSheet.create({
  card: {marginHorizontal: 16, marginTop: 12, padding: 14, borderRadius: 16, backgroundColor: '#FFF'},
  row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  title: {fontSize: 16, fontWeight: '600', color: '#3D4A5C'}, label: {fontSize: 14, color: '#3D4A5C'},
  detail: {fontSize: 12, lineHeight: 18, color: '#75808A', marginTop: 4},
  retry: {fontSize: 13, color: '#245AA4', marginTop: 8},
});
