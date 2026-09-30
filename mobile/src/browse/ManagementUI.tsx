import React, {useCallback, useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {BrowseApi, type Folder} from './api';
import {operationError} from './management';

export function Action({label, onPress, disabled = false, danger = false, selected = false}: {
  label: string; onPress: () => void; disabled?: boolean; danger?: boolean; selected?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled, selected}}
    disabled={disabled} onPress={onPress} style={[ui.action, selected && ui.active, disabled && ui.disabled]}>
    <Text style={[ui.actionText, danger && ui.danger]}>{label}</Text>
  </Pressable>;
}

export function Sheet({title, close, busy = false, children}: {title: string; close: () => void; busy?: boolean; children: React.ReactNode}) {
  return <Modal transparent animationType="slide" onRequestClose={() => {if (!busy) {close();}}}>
    <View style={ui.backdrop}><View style={ui.sheet} accessibilityViewIsModal>
      <View style={ui.row}><Text accessibilityRole="header" style={ui.heading}>{title}</Text><Action label="关闭" onPress={close} disabled={busy} /></View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={ui.sheetContent}>{children}</ScrollView>
      {busy ? <ActivityIndicator color="#3D4A5C" /> : null}
    </View></View>
  </Modal>;
}

export function FolderPicker({api, close, choose, writable = true, ownerId}: {
  api: BrowseApi; close: () => void; choose: (folder: Folder) => void; writable?: boolean; ownerId?: string;
}) {
  const [stack, setStack] = useState<Folder[]>([]);
  const current = stack.at(-1);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const revision = useSyncExternalStore(api.subscribe, api.getRevision);
  const load = useCallback(async () => {
    const ticket = ++generation.current;
    setLoading(true); setError(''); setFolders([]);
    try {
      const result = await api.listFolders(current?.id);
      if (ticket === generation.current) {setFolders(result.filter(folder => !ownerId || folder.owner_id === ownerId));}
    } catch (e) {if (ticket === generation.current) {setError(operationError(e));}}
    finally {if (ticket === generation.current) {setLoading(false);}}
  }, [api, current?.id, ownerId]);
  useEffect(() => {load(); const ticket = generation.current; return () => {generation.current = ticket + 1;};}, [load, revision]);
  return <Sheet title={writable ? '选择目标文件夹' : '按文件夹筛选'} close={close}>
    <Text style={ui.copy}>{stack.map(folder => folder.name).join(' / ') || '服务器文件夹'}</Text>
    {current ? <View style={ui.row}>
      <Action label="返回上级" onPress={() => setStack(old => old.slice(0, -1))} />
      <Action label="选择此目录" disabled={loading || !!error || (writable && current.effective_permission !== 'write')}
        onPress={() => choose(current)} />
    </View> : null}
    {current?.effective_permission === 'read' && writable ? <Text style={ui.copy}>此目录只读，可继续查找有写入权限的子目录。</Text> : null}
    {loading ? <ActivityIndicator /> : error ? <><Text accessibilityRole="alert" style={ui.error}>{error}</Text><Action label="重试加载目录" onPress={load} /></> :
      folders.length ? folders.map(folder => <Action key={folder.id} label={`${folder.name}${folder.effective_permission === 'read' ? ' · 只读' : ''} ›`} onPress={() => setStack(old => [...old, folder])} />) :
        <Text style={ui.copy}>这里没有子文件夹</Text>}
  </Sheet>;
}

export function CreateFolder({api, parent, close, created}: {api: BrowseApi; parent?: Folder; close: () => void; created: () => void}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function create() {
    if (!name.trim() || busy) {return;}
    setBusy(true); setError('');
    try {await api.createFolder(name.trim(), parent?.id ?? null); created(); close();}
    catch (e) {setError(operationError(e));}
    finally {setBusy(false);}
  }
  return <Sheet title="新建文件夹" close={close} busy={busy}>
    <Text style={ui.copy}>位置：{parent?.name ?? '根目录'}</Text>
    <TextInput accessibilityLabel="文件夹名称" autoFocus editable={!busy} value={name} onChangeText={setName}
      placeholder="文件夹名称" maxLength={255} style={ui.input} onSubmitEditing={create} />
    {error ? <Text accessibilityRole="alert" style={ui.error}>{error}</Text> : null}
    <Action label="创建文件夹" onPress={create} disabled={!name.trim() || busy} />
  </Sheet>;
}

export const ui = StyleSheet.create({
  failures: {maxHeight: 160, flexGrow: 0},
  row: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4},
  action: {minHeight: 48, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 12},
  actionText: {color: '#3D4A5C', fontSize: 14, fontWeight: '600'}, active: {backgroundColor: '#E7F0EB'}, disabled: {opacity: 0.4}, danger: {color: '#A3372C'},
  backdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: '#0008'},
  sheet: {maxHeight: '88%', backgroundColor: '#FAF9F7', borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 16, paddingBottom: 32},
  sheetContent: {paddingBottom: 20}, heading: {flex: 1, color: '#3D4A5C', fontWeight: '700', fontSize: 20},
  copy: {color: '#75808A', fontSize: 14, marginVertical: 8}, error: {color: '#A3372C', marginVertical: 8},
  input: {minHeight: 48, borderWidth: 1, borderColor: '#E8E5E1', borderRadius: 12, paddingHorizontal: 12, color: '#3D4A5C', marginVertical: 6, backgroundColor: '#FFF'},
});
