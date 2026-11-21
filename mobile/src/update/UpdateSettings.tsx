import React, {useEffect, useRef, useState} from 'react';
import {Linking, StyleSheet, Text, View} from 'react-native';
import {Action, ui} from '../browse/ManagementUI';
import {checkForUpdate, currentVersion, type AndroidRelease} from './releases';
import {colors, hairline, radius} from '../ui/theme';

export default function UpdateSettings() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [release, setRelease] = useState<AndroidRelease | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => {request.current?.abort();}, []);

  async function check() {
    if (request.current) {return;}
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(''); setMessage(''); setRelease(null);
    try {
      const result = await checkForUpdate(controller.signal);
      if (!controller.signal.aborted) {
        setRelease(result);
        setMessage(result ? `发现新版本 ${result.version}` : '当前已是最新版本');
      }
    } catch (problem) {
      if (!controller.signal.aborted) {setError(problem instanceof Error ? problem.message : '检查更新失败，请重试');}
    } finally {
      if (!controller.signal.aborted) {setBusy(false);}
      if (request.current === controller) {request.current = null;}
    }
  }

  async function open(url: string) {
    setError('');
    try {await Linking.openURL(url);}
    catch {setError('无法打开浏览器，请稍后重试');}
  }

  return <View style={styles.section}>
    <Text accessibilityRole="header" style={styles.caption}>应用更新</Text>
    <View style={styles.card}>
      <View style={styles.row}>
        <View style={styles.meta}>
          <Text style={styles.version}>当前版本 {currentVersion}</Text>
          <Text style={styles.arch}>Android ARM64</Text>
        </View>
        <Action label={busy ? '正在检查更新…' : '检查更新'} disabled={busy} onPress={check} />
      </View>
      {message ? <Text accessibilityLiveRegion="polite" style={styles.message}>{message}</Text> : null}
      {release ? <View style={styles.releaseBox}>
        <Text style={styles.notes}>{release.notes.trim() || '此版本未提供更新说明。'}</Text>
        <Text style={ui.copy}>在浏览器中下载安装包，下载完成后打开并按系统提示安装。</Text>
        <View style={ui.row}>
          <Action label="下载新版本" variant="primary" onPress={() => open(release.downloadUrl)} />
          <Action label="查看发布页面" onPress={() => open(release.pageUrl)} />
        </View>
      </View> : null}
      {error ? <Text accessibilityRole="alert" style={ui.error}>{error}</Text> : null}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  section: {marginHorizontal: 16, marginBottom: 18},
  caption: {color: colors.muted, fontSize: 12, fontWeight: '600', marginBottom: 8, marginLeft: 4},
  card: {padding: 14, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: 8},
  row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12},
  meta: {flex: 1},
  version: {color: colors.ink, fontSize: 15, fontWeight: '600'},
  arch: {color: colors.muted, fontSize: 12, marginTop: 2},
  message: {color: colors.ink, fontSize: 13},
  releaseBox: {borderTopWidth: hairline, borderTopColor: colors.hairline, paddingTop: 10, gap: 6},
  notes: {color: colors.ink, fontSize: 13, lineHeight: 19},
});
