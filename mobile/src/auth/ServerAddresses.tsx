import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {IdentityError, profileFor, verifyAddress, type ServerProfile} from './connection';
import {normalizeServer} from './server';
import type {BrowseApi} from '../browse/api';
import type {MobileSession} from './session';

export default function ServerAddresses({api, session}: {api: BrowseApi; session: MobileSession}) {
  const profile = profileFor(session);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [editing, setEditing] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [, redraw] = useState(0);
  async function run(action: () => Promise<void>) {
    if (busy) {return;}
    setBusy(true); setNotice('');
    try {await action();} catch (error) {setNotice(error instanceof Error ? error.message : '操作失败');}
    finally {setBusy(false); redraw(value => value + 1);}
  }
  async function bind(): Promise<ServerProfile> {
    if (profile.publicKey) {return profile;}
    const publicKey = await verifyAddress(session.server);
    const next = {...profile, publicKey, addresses: profile.addresses.map(a => ({...a, verified: a.url === session.server}))};
    await api.updateProfile(next);
    return next;
  }
  async function save() {
    const address = normalizeServer(url);
    if (profile.addresses.some(a => a.url === address && a.url !== editing)) {throw new Error('该地址已添加');}
    if (!editing && profile.addresses.length >= 8) {throw new Error('最多添加 8 个地址');}
    const bound = await bind();
    // Retain an offline address as pending; only successful proof enables it.
    let verified = false;
    let failure = '';
    try {await verifyAddress(address, bound.publicKey); verified = true;} catch (error) {if (error instanceof IdentityError) {throw error;} failure = error instanceof Error ? error.message : '无法验证地址';}
    if (!verified && editing === session.server) {throw new Error(failure);}
    const entry = {url: address, name: name.trim() || '备用地址', verified};
    const addresses = editing ? bound.addresses.map(a => a.url === editing ? entry : a) : [...bound.addresses, entry];
    const next = {...bound, addresses, manual: bound.manual === editing ? undefined : bound.manual};
    await api.updateProfile(next);
    setUrl(''); setName(''); setEditing(undefined);
    setNotice(verified ? '地址已验证，可用于连接' : `已保存为待验证地址：${failure}`);
    if (editing === session.server && address !== editing) {await api.reconnect(true);}
  }
  return <View style={styles.section}>
    <Text style={styles.title}>服务器地址</Text>
    <Text style={styles.hint}>当前连接：{session.server}</Text>
    <Text style={styles.hint}>{profile.manual ? '手动模式：仅使用指定地址' : '自动模式：优先上次成功地址，失败后按列表顺序切换'}</Text>
    {profile.addresses.map((address, index) => <View key={address.url} style={styles.card}>
      <Text style={styles.label}>{address.name}{address.url === session.server ? ' · 当前' : ''}{address.url === profile.manual ? ' · 手动指定' : ''}</Text>
      <Text selectable style={styles.hint}>{address.url}</Text>
      <Text style={styles.hint}>{api.connection.statuses.get(address.url) ?? (address.verified ? '已验证' : '待验证')}</Text>
      <View style={styles.actions}>
        <Action title="检测" disabled={busy} onPress={() => run(async () => {
          const bound = await bind();
          try {
            await verifyAddress(address.url, bound.publicKey);
            api.connection.statuses.set(address.url, '可连接');
            await api.updateProfile({...bound, addresses: bound.addresses.map(a => a.url === address.url ? {...a, verified: true} : a)});
            setNotice('地址验证成功');
          } catch (error) {api.connection.statuses.set(address.url, error instanceof IdentityError ? '身份不匹配' : '不可连接'); throw error;}
        })} />
        <Action title="使用" disabled={busy || !address.verified} onPress={() => run(async () => {
          await verifyAddress(address.url, profile.publicKey);
          await api.updateProfile({...profile, manual: address.url}); await api.reconnect(true);
        })} />
        <Action title="编辑" disabled={busy} onPress={() => {setEditing(address.url); setUrl(address.url); setName(address.name);}} />
        <Action title="上移" disabled={busy || index === 0} onPress={() => run(async () => {
          const addresses = [...profile.addresses];
          [addresses[index - 1], addresses[index]] = [addresses[index], addresses[index - 1]];
          await api.updateProfile({...profile, addresses});
        })} />
        <Action title="删除" disabled={busy || profile.addresses.length === 1} onPress={() => run(async () => {
          if (address.url === session.server && !profile.addresses.some(a => a.url !== address.url && a.verified)) {throw new Error('请先验证另一个地址');}
          await api.updateProfile({...profile, manual: profile.manual === address.url ? undefined : profile.manual, addresses: profile.addresses.filter(a => a.url !== address.url)});
          if (address.url === session.server) {await api.reconnect(true);}
        })} />
      </View>
    </View>)}
    <View style={styles.actions}>
      <Action title="自动选择地址" disabled={busy} onPress={() => run(async () => {await api.updateProfile({...profile, manual: undefined}); await api.reconnect(true);})} />
      <Action title="重新连接" disabled={busy} onPress={() => run(async () => {await api.reconnect(true); setNotice('连接成功');})} />
    </View>
    <Text style={styles.label}>{editing ? '编辑地址' : '添加备用地址'}</Text>
    <TextInput accessibilityLabel="地址名称" style={styles.input} value={name} onChangeText={setName} placeholder="名称，例如：组网访问" editable={!busy} />
    <TextInput accessibilityLabel="备用服务器地址" style={styles.input} value={url} onChangeText={setUrl} placeholder="http://100.90.1.10:8080" autoCapitalize="none" autoCorrect={false} keyboardType="url" editable={!busy} />
    {url.trim().toLowerCase().startsWith('http://') ? <Text style={styles.warning}>HTTP 连接未加密，请仅在可信内网或加密组网中使用。</Text> : null}
    <Action title={busy ? '正在处理…' : '保存并验证'} disabled={busy || !url.trim()} onPress={() => run(save)} />
    {editing ? <Action title="取消编辑" disabled={busy} onPress={() => {setEditing(undefined); setUrl(''); setName('');}} /> : null}
    {notice ? <Text accessibilityRole="alert" style={styles.warning}>{notice}</Text> : null}
  </View>;
}
function Action({title, disabled, onPress}: {title: string; disabled: boolean; onPress: () => void}) {
  return <Pressable accessibilityRole="button" accessibilityState={{disabled}} disabled={disabled} onPress={onPress} style={[styles.button, disabled && styles.disabled]}><Text style={styles.label}>{title}</Text></Pressable>;
}
const styles = StyleSheet.create({
  section: {padding: 20, gap: 10}, title: {fontSize: 20, fontWeight: '600', color: '#3D4A5C'},
  label: {color: '#3D4A5C', fontSize: 14}, hint: {color: '#75808A', fontSize: 13, lineHeight: 20},
  card: {padding: 12, borderRadius: 14, backgroundColor: '#FFFFFF', gap: 5}, actions: {flexDirection: 'row', flexWrap: 'wrap', gap: 6},
  button: {minHeight: 48, justifyContent: 'center', paddingHorizontal: 12, backgroundColor: '#EEE9E1', borderRadius: 12},
  disabled: {opacity: 0.4}, input: {borderWidth: 1, borderColor: '#DCD7D0', borderRadius: 12, padding: 12, color: '#3D4A5C'},
  warning: {color: '#A65757', lineHeight: 20},
});
