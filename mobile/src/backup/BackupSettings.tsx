import React, {useEffect, useState} from 'react';
import {AppState, Pressable, StyleSheet, Switch, Text, View} from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import type {MobileSession} from '../auth/session';
import type {BrowseApi, Folder} from '../browse/api';
import {bindBackup, cancelVisibleBackup, configureBackup, isVisibleBackupRunning, pauseVisibleBackup, readBackup, requestMediaAccess,
  restoreBackupSchedule, retryBlockedBackup, runBackup, runVisibleBackup, subscribeBackup, type BackupSettings as Settings} from './service';
import {colors, hairline, radius} from '../ui/theme';

type Props = {session: MobileSession; api: BrowseApi; folder: Folder | null};
export default function BackupSettings({session, api, folder}: Props) {
  const [settings, setSettings] = useState<Settings>({enabled: false, videoEnabled: false, wifiOnly: true, folder: null, dateFolders: true});
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
  const backupFolder = settings.enabled || settings.videoEnabled ? settings.folder : folder ?? settings.folder;
  return <View style={styles.wrapper}>
    <View style={styles.card}>
      <View style={styles.section}>
        <View style={styles.row}>
          <Text style={styles.title}>自动备份照片</Text>
          <Switch accessibilityLabel="自动备份照片" value={settings.enabled} disabled={busy || !ready}
            trackColor={{false: '#DED9D2', true: colors.sageBar}} thumbColor={colors.surface}
            onValueChange={enabled => change({...settings, enabled, folder: enabled ? backupFolder : settings.folder})} />
        </View>
        <Text style={styles.detail}>开启后备份系统相册中的全部照片及后续新增照片。后台由系统定期执行；强行停止应用后需重新打开。</Text>
      </View>

      <View style={[styles.section, styles.divider]}>
        <View style={styles.row}>
          <Text style={styles.title}>备份视频</Text>
          <Switch accessibilityLabel="备份视频" value={!!settings.videoEnabled} disabled={busy || !ready}
            trackColor={{false: '#DED9D2', true: colors.sageBar}} thumbColor={colors.surface}
            onValueChange={videoEnabled => change({...settings, videoEnabled, folder: videoEnabled ? backupFolder : settings.folder})} />
        </View>
        <Text style={styles.detail}>默认关闭。开启后扫描现有及新增的 MP4、WebM；超过 128 MB 的视频等待你启动可见传输，其他格式会显示未完成原因。</Text>
        {settings.videoEnabled ? visibleActive ? <View style={styles.actionRow}>
          <Pressable style={styles.pill} accessibilityRole="button" onPress={() => pauseVisibleBackup().catch(error => setMessage(error instanceof Error ? error.message : '暂停失败'))}>
            <Text style={styles.pillText}>暂停视频传输</Text>
          </Pressable>
          <Pressable style={[styles.pill, styles.pillDanger]} accessibilityRole="button" onPress={() => cancelVisibleBackup().catch(error => setMessage(error instanceof Error ? error.message : '取消失败'))}>
            <Text style={[styles.pillText, styles.pillDangerText]}>取消本次传输</Text>
          </Pressable>
        </View> : <Pressable style={styles.pill} accessibilityRole="button" disabled={busy || startingVisible} onPress={() => {
          setStartingVisible(true);
          runVisibleBackup(session, api).catch(error => setMessage(error instanceof Error ? error.message : '无法启动可见视频传输'))
            .finally(() => setStartingVisible(false));
        }}><Text style={styles.pillText}>{pendingVideo ? '继续待处理视频' : '开始可见视频传输'}</Text></Pressable> : null}
        {settings.videoEnabled ? <Text style={styles.detail}>可见传输会显示系统通知，可从通知暂停或取消。</Text> : null}
      </View>

      <View style={[styles.section, styles.divider]}>
        <View style={styles.row}>
          <Text style={styles.label}>按年月日归档</Text>
          <Switch accessibilityLabel="按年月日归档" value={!!settings.dateFolders} disabled={busy || !ready || settings.enabled || !!settings.videoEnabled}
            trackColor={{false: '#DED9D2', true: colors.sageBar}} thumbColor={colors.surface}
            onValueChange={dateFolders => change({...settings, dateFolders})} />
        </View>
        <Text style={styles.detail}>备份根目录：{settings.folder?.name ?? '开启时使用所选根目录'}。{settings.dateFolders ? '按拍摄日期自动创建 年/月/日 目录（无日期时放入“日期未知”）。' : '照片和视频直接上传到备份根目录。'}更改目录或归档方式请先关闭备份。</Text>
      </View>

      <View style={[styles.section, styles.divider]}>
        <View style={styles.row}>
          <Text style={styles.label}>仅 Wi-Fi</Text>
          <Switch accessibilityLabel="仅 Wi-Fi 自动备份" value={settings.wifiOnly} disabled={busy || !ready}
            trackColor={{false: '#DED9D2', true: colors.sageBar}} thumbColor={colors.surface}
            onValueChange={wifiOnly => change({...settings, wifiOnly})} />
        </View>
      </View>
    </View>

    <View style={styles.statusCard}>
      <Text style={styles.statusTitle}>已确认 {completed.photo} 张照片、{completed.video} 个视频</Text>
      {lastRun ? <Text style={styles.detail}>照片最近完整检查：{new Date(lastRun).toLocaleString()}</Text> : null}
      {lastVideoRun ? <Text style={styles.detail}>视频最近完整检查：{new Date(lastVideoRun).toLocaleString()}</Text> : null}
      {blocked > 0 || targetBlocked ? <Pressable style={styles.pill} accessibilityRole="button" disabled={busy} onPress={() => {
        setBusy(true);
        retryBlockedBackup(session).then(() => runBackup(session, api)).catch(error => setMessage(error instanceof Error ? error.message : '重新检查失败'))
          .finally(() => setBusy(false));
      }}><Text style={styles.pillText}>重新检查{targetBlocked ? '目标文件夹' : `${blocked} 项未完成媒体`}</Text></Pressable> : null}
      {message ? <Text accessibilityLiveRegion="polite" style={styles.message}>{message}</Text> : null}
    </View>
  </View>;
}
const styles = StyleSheet.create({
  wrapper: {marginHorizontal: 16, marginTop: 12, gap: 12},
  card: {borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, overflow: 'hidden'},
  section: {padding: 14},
  divider: {borderTopWidth: hairline, borderTopColor: colors.hairline},
  row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12},
  title: {fontSize: 15, fontWeight: '600', color: colors.ink},
  label: {fontSize: 15, fontWeight: '500', color: colors.ink},
  detail: {fontSize: 12, lineHeight: 18, color: colors.muted, marginTop: 6},
  actionRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10},
  pill: {alignSelf: 'flex-start', marginTop: 10, minHeight: 36, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: colors.recessed, borderWidth: 1, borderColor: colors.border, justifyContent: 'center'},
  pillDanger: {backgroundColor: colors.dangerSoft, borderColor: '#EBC9C5'},
  pillText: {fontSize: 13, fontWeight: '600', color: colors.ink},
  pillDangerText: {color: colors.danger},
  statusCard: {padding: 14, borderRadius: radius.lg, backgroundColor: colors.recessed, borderWidth: 1, borderColor: colors.border},
  statusTitle: {fontSize: 13, fontWeight: '600', color: colors.ink},
  message: {fontSize: 12, lineHeight: 18, color: colors.ink, marginTop: 6},
});
