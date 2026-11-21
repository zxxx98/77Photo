import React, {useCallback, useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {BrowseApi, type Folder} from './api';
import {operationError} from './management';
import {colors, hairline, radius} from '../ui/theme';

export type ActionVariant = 'chip' | 'primary' | 'ghost' | 'danger';

export function Action({label, onPress, disabled = false, danger = false, selected = false, variant}: {
  label: string; onPress: () => void; disabled?: boolean; danger?: boolean; selected?: boolean; variant?: ActionVariant;
}) {
  const mode: ActionVariant = variant ?? (danger ? 'danger' : 'chip');
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled, selected}}
    hitSlop={4} disabled={disabled} onPress={onPress}
    style={({pressed}) => [
      ui.action,
      mode === 'chip' && ui.chip,
      mode === 'primary' && ui.primary,
      mode === 'ghost' && ui.ghost,
      mode === 'danger' && ui.dangerChip,
      mode === 'primary' && danger && ui.dangerPrimary,
      selected && ui.active,
      pressed && !disabled && ui.pressed,
      disabled && ui.disabled,
    ]}>
    <Text style={[
      ui.actionText,
      mode === 'primary' && ui.primaryText,
      mode !== 'primary' && danger && ui.dangerText,
      selected && ui.activeText,
    ]}>{label}</Text>
  </Pressable>;
}

export function Sheet({title, close, busy = false, children}: {title: string; close: () => void; busy?: boolean; children: React.ReactNode}) {
  return <Modal transparent animationType="slide" onRequestClose={() => {if (!busy) {close();}}}>
    <View style={ui.backdrop}>
      <Pressable style={ui.backdropTap} onPress={() => {if (!busy) {close();}}} accessibilityElementsHidden importantForAccessibility="no" />
      <View style={ui.sheet} accessibilityViewIsModal>
        <View style={ui.handle} />
        <View style={ui.sheetHeader}>
          <Text accessibilityRole="header" style={ui.heading}>{title}</Text>
          <Action label="关闭" variant="ghost" onPress={close} disabled={busy} />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={ui.sheetContent}>{children}</ScrollView>
        {busy ? <ActivityIndicator style={ui.sheetSpinner} color={colors.ink} /> : null}
      </View>
    </View>
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
    <Text style={ui.pathBanner}>{stack.map(folder => folder.name).join(' / ') || '服务器文件夹'}</Text>
    {current ? <View style={[ui.row, ui.pickerControls]}>
      <Action label="返回上级" onPress={() => setStack(old => old.slice(0, -1))} />
      <Action label="选择此目录" variant="primary" disabled={loading || !!error || (writable && current.effective_permission !== 'write')}
        onPress={() => choose(current)} />
    </View> : null}
    {current?.effective_permission === 'read' && writable ? <Text style={ui.copy}>此目录只读，可继续查找有写入权限的子目录。</Text> : null}
    {loading ? <ActivityIndicator style={ui.pickerSpinner} color={colors.ink} /> : error ? <><Text accessibilityRole="alert" style={ui.error}>{error}</Text><Action label="重试加载目录" onPress={load} /></> :
      folders.length ? <View style={ui.groupedList}>
        {folders.map((folder, index) => <Pressable key={folder.id} accessibilityRole="button"
          accessibilityLabel={`${folder.name}${folder.effective_permission === 'read' ? ' · 只读' : ''} ›`}
          onPress={() => setStack(old => [...old, folder])}
          style={({pressed}) => [ui.listRow, index > 0 && ui.listRowBorder, pressed && ui.pressed]}>
          <Text style={ui.listRowTitle} numberOfLines={1}>{folder.name}</Text>
          <Text style={ui.listRowMeta}>{folder.effective_permission === 'read' ? '只读' : ''} ›</Text>
        </Pressable>)}
      </View> : <Text style={ui.copy}>这里没有子文件夹</Text>}
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
      placeholder="输入文件夹名称" placeholderTextColor={colors.subtle} maxLength={255} style={ui.input} onSubmitEditing={create} />
    {error ? <Text accessibilityRole="alert" style={ui.error}>{error}</Text> : null}
    <View style={ui.sheetFooter}>
      <Action label="创建文件夹" variant="primary" onPress={create} disabled={!name.trim() || busy} />
    </View>
  </Sheet>;
}

export const ui = StyleSheet.create({
  failures: {maxHeight: 160, flexGrow: 0, marginTop: 8},
  row: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8},
  action: {minHeight: 38, paddingHorizontal: 14, justifyContent: 'center', alignItems: 'center', borderRadius: radius.pill, borderWidth: 1, borderColor: 'transparent'},
  chip: {backgroundColor: colors.recessed, borderColor: colors.border},
  primary: {minHeight: 46, borderRadius: radius.md, backgroundColor: colors.ink, borderColor: colors.ink, paddingHorizontal: 18},
  ghost: {backgroundColor: 'transparent', paddingHorizontal: 10},
  dangerChip: {backgroundColor: colors.dangerSoft, borderColor: '#EBC9C5'},
  dangerPrimary: {backgroundColor: colors.danger, borderColor: colors.danger},
  actionText: {color: colors.ink, fontSize: 13, fontWeight: '600'},
  primaryText: {color: colors.paper, fontSize: 14, fontWeight: '600'},
  dangerText: {color: colors.danger},
  active: {backgroundColor: colors.blushSoft, borderColor: colors.blush},
  activeText: {color: colors.ink},
  pressed: {opacity: 0.72},
  disabled: {opacity: 0.42},
  backdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(17, 21, 26, 0.45)'},
  backdropTap: {flex: 1},
  sheet: {maxHeight: '86%', backgroundColor: colors.paper, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 28},
  handle: {width: 36, height: 4, borderRadius: 2, backgroundColor: '#D6D0C7', alignSelf: 'center', marginBottom: 10},
  sheetHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 10, borderBottomWidth: hairline, borderBottomColor: colors.hairline, marginBottom: 8},
  sheetContent: {paddingBottom: 16},
  sheetFooter: {marginTop: 12},
  sheetSpinner: {marginTop: 8},
  heading: {flex: 1, color: colors.ink, fontWeight: '700', fontSize: 18},
  copy: {color: colors.muted, fontSize: 13, lineHeight: 20, marginVertical: 6},
  error: {color: colors.danger, fontSize: 13, lineHeight: 20, marginVertical: 6},
  input: {minHeight: 46, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, color: colors.ink, fontSize: 15, marginVertical: 6, backgroundColor: colors.surface},
  pathBanner: {color: colors.muted, fontSize: 12, fontWeight: '600', marginTop: 4, marginBottom: 10},
  pickerControls: {marginBottom: 10},
  pickerSpinner: {marginVertical: 20},
  groupedList: {backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden', marginTop: 4},
  listRow: {minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14},
  listRowBorder: {borderTopWidth: hairline, borderTopColor: colors.hairline},
  listRowTitle: {flex: 1, color: colors.ink, fontSize: 15, fontWeight: '500', marginRight: 8},
  listRowMeta: {color: colors.muted, fontSize: 13},
});
