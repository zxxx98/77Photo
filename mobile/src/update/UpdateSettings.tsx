import React, {useEffect, useRef, useState} from 'react';
import {Linking, StyleSheet, Text, View} from 'react-native';
import {Action, ui} from '../browse/ManagementUI';
import {checkForUpdate, currentVersion, type AndroidRelease} from './releases';

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

  return <View style={styles.card}>
    <Text accessibilityRole="header" style={ui.heading}>应用更新</Text>
    <Text style={ui.copy}>当前版本 {currentVersion} · Android ARM64</Text>
    <Action label={busy ? '正在检查更新…' : '检查更新'} disabled={busy} onPress={check} />
    {message ? <Text accessibilityLiveRegion="polite" style={ui.copy}>{message}</Text> : null}
    {release ? <>
      <Text style={ui.copy}>{release.notes.trim() || '此版本未提供更新说明。'}</Text>
      <Text style={ui.copy}>在浏览器中下载安装包，下载完成后打开并按系统提示安装。</Text>
      <Action label="下载新版本" onPress={() => open(release.downloadUrl)} />
      <Action label="查看发布页面" onPress={() => open(release.pageUrl)} />
    </> : null}
    {error ? <Text accessibilityRole="alert" style={ui.error}>{error}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  card: {padding: 16, marginVertical: 16, borderRadius: 16, backgroundColor: '#FFFFFF', gap: 4},
});
