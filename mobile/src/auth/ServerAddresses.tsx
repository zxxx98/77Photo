import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {IdentityError, profileFor, verifyAddress, type ServerProfile} from './connection';
import {normalizeServer} from './server';
import type {BrowseApi} from '../browse/api';
import type {MobileSession} from './session';
import {colors, hairline, radius} from '../ui/theme';

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
    <Text style={styles.sectionCaption}>服务器地址</Text>
    <View style={styles.group}>
      <View style={styles.modeBox}>
        <Text style={styles.modeTitle}>连接策略：{profile.manual ? '手动指定' : '自动切换'}</Text>
        <Text style={styles.hint}>{profile.manual ? '仅使用手动指定的服务器地址' : '优先使用上次成功地址，不可达时按列表顺序切换'}</Text>
        <View style={styles.modeActions}>
          <Action title="自动选择地址" disabled={busy} onPress={() => run(async () => {await api.updateProfile({...profile, manual: undefined}); await api.reconnect(true);})} />
          <Action title="重新连接" disabled={busy} onPress={() => run(async () => {await api.reconnect(true); setNotice('连接成功');})} />
        </View>
      </View>
      {profile.addresses.map((address, index) => {
        const statusText = api.connection.statuses.get(address.url) ?? (address.verified ? '已验证' : '待验证');
        const isCurrent = address.url === session.server;
        const isManual = address.url === profile.manual;
        return <View key={address.url} style={[styles.addressRow, styles.rowDivider]}>
          <View style={styles.addressHeader}>
            <Text style={styles.label}>{address.name}</Text>
            <View style={styles.badges}>
              {isCurrent ? <Text style={[styles.badge, styles.badgeActive]}>当前</Text> : null}
              {isManual ? <Text style={styles.badge}>手动</Text> : null}
              <Text style={[styles.badge, (statusText === '可连接' || statusText === '已验证') && styles.badgeGood]}>{statusText}</Text>
            </View>
          </View>
          <Text selectable style={styles.urlText}>{address.url}</Text>
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
            <Action title="删除" danger disabled={busy || profile.addresses.length === 1} onPress={() => run(async () => {
              if (address.url === session.server && !profile.addresses.some(a => a.url !== address.url && a.verified)) {throw new Error('请先验证另一个地址');}
              await api.updateProfile({...profile, manual: profile.manual === address.url ? undefined : profile.manual, addresses: profile.addresses.filter(a => a.url !== address.url)});
              if (address.url === session.server) {await api.reconnect(true);}
            })} />
          </View>
        </View>;
      })}
    </View>

    <Text style={[styles.sectionCaption, styles.formCaption]}>{editing ? '编辑地址' : '添加备用地址'}</Text>
    <View style={styles.formGroup}>
      <TextInput accessibilityLabel="地址名称" style={styles.input} value={name} onChangeText={setName}
        placeholder="名称，例如：组网访问" placeholderTextColor={colors.subtle} editable={!busy} />
      <TextInput accessibilityLabel="备用服务器地址" style={styles.input} value={url} onChangeText={setUrl}
        placeholder="http://100.90.1.10:8080" placeholderTextColor={colors.subtle} autoCapitalize="none" autoCorrect={false} keyboardType="url" editable={!busy} />
      {url.trim().toLowerCase().startsWith('http://') ? <Text style={styles.warning}>HTTP 连接未加密，请仅在可信内网或加密组网中使用。</Text> : null}
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" accessibilityState={{disabled: busy || !url.trim()}} disabled={busy || !url.trim()}
          onPress={() => run(save)} style={({pressed}) => [styles.saveButton, (busy || !url.trim()) && styles.disabled, pressed && styles.pressed]}>
          <Text style={styles.saveButtonText}>{busy ? '正在处理…' : '保存并验证'}</Text>
        </Pressable>
        {editing ? <Action title="取消编辑" disabled={busy} onPress={() => {setEditing(undefined); setUrl(''); setName('');}} /> : null}
      </View>
      {notice ? <Text accessibilityRole="alert" style={styles.warning}>{notice}</Text> : null}
    </View>
  </View>;
}

function Action({title, disabled, danger = false, onPress}: {title: string; disabled: boolean; danger?: boolean; onPress: () => void}) {
  return <Pressable accessibilityRole="button" accessibilityState={{disabled}} hitSlop={4} disabled={disabled} onPress={onPress}
    style={({pressed}) => [styles.button, danger && styles.buttonDanger, disabled && styles.disabled, pressed && !disabled && styles.pressed]}>
    <Text style={[styles.buttonText, danger && styles.buttonDangerText]}>{title}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  section: {marginHorizontal: 16, marginBottom: 18},
  sectionCaption: {color: colors.muted, fontSize: 12, fontWeight: '600', marginBottom: 8, marginLeft: 4},
  formCaption: {marginTop: 18},
  group: {backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden'},
  modeBox: {padding: 14, gap: 6},
  modeTitle: {color: colors.ink, fontSize: 14, fontWeight: '600'},
  modeActions: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4},
  rowDivider: {borderTopWidth: hairline, borderTopColor: colors.hairline},
  addressRow: {padding: 14, gap: 6},
  addressHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8},
  label: {color: colors.ink, fontSize: 15, fontWeight: '600'},
  badges: {flexDirection: 'row', flexWrap: 'wrap', gap: 4},
  badge: {fontSize: 11, fontWeight: '600', color: colors.muted, backgroundColor: colors.recessed, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, overflow: 'hidden'},
  badgeActive: {color: colors.ink, backgroundColor: colors.blushSoft},
  badgeGood: {color: colors.sage, backgroundColor: colors.sageSoft},
  urlText: {color: colors.muted, fontSize: 13},
  hint: {color: colors.muted, fontSize: 12, lineHeight: 18},
  actions: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4},
  button: {minHeight: 34, justifyContent: 'center', paddingHorizontal: 12, backgroundColor: colors.recessed, borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill},
  buttonDanger: {backgroundColor: colors.dangerSoft, borderColor: '#EBC9C5'},
  buttonText: {color: colors.ink, fontSize: 12, fontWeight: '600'},
  buttonDangerText: {color: colors.danger},
  pressed: {opacity: 0.72},
  disabled: {opacity: 0.42},
  formGroup: {backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 14, gap: 10},
  input: {minHeight: 46, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 12, color: colors.ink, fontSize: 14, backgroundColor: colors.paper},
  saveButton: {minHeight: 42, paddingHorizontal: 16, borderRadius: radius.md, backgroundColor: colors.ink, justifyContent: 'center', alignItems: 'center'},
  saveButtonText: {color: colors.paper, fontSize: 13, fontWeight: '600'},
  warning: {color: colors.danger, fontSize: 12, lineHeight: 18},
});
