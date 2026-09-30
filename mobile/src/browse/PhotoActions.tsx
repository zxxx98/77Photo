import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, BackHandler, ScrollView, Text, View} from 'react-native';
import {BrowseApi, type BatchFailure, type Folder, type Photo} from './api';
import {Action, FolderPicker, Sheet, ui} from './ManagementUI';
import {moveSelected, operationError, runBatches} from './management';

export function usePhotoSelection() {
  const [selecting, setSelecting] = useState(false);
  const [ids, setIds] = useState<Set<string>>(new Set());
  function toggle(id: string) {
    setIds(old => {const next = new Set(old); next.has(id) ? next.delete(id) : next.add(id); return next;});
  }
  function toggleDay(photos: Photo[]) {
    setIds(old => {
      const next = new Set(old); const clear = photos.every(photo => next.has(photo.id));
      photos.forEach(photo => {if (clear) {next.delete(photo.id);} else {next.add(photo.id);}});
      return next;
    });
  }
  const reset = useCallback(() => {setSelecting(false); setIds(new Set());}, []);
  useEffect(() => {
    if (!selecting) {return;}
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {reset(); return true;});
    return () => subscription.remove();
  }, [selecting, reset]);
  return {selecting, ids, setIds, toggle, toggleDay, reset,
    start: (id?: string) => {setSelecting(true); if (id) {setIds(new Set([id]));}}};
}

export function PhotoActions({api, photos, completed, close, retain}: {
  api: BrowseApi; photos: Photo[]; completed: (ids: string[]) => void; close: () => void; retain?: (ids: string[]) => void;
}) {
  const [mode, setMode] = useState<'delete' | 'move' | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [target, setTarget] = useState<Folder | null>(null);
  const [rename, setRename] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [failures, setFailures] = useState<BatchFailure[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [checking, setChecking] = useState(true);
  const [permissionError, setPermissionError] = useState('');
  const folderKey = JSON.stringify([...new Set(photos.map(photo => photo.folder_id))].sort());
  useEffect(() => {
    let active = true; setChecking(true); setPermissionError(''); setCanWrite(false);
    const folders: string[] = JSON.parse(folderKey);
    async function check() {
      let next = 0;
      let writable = false;
      await Promise.all(Array.from({length: Math.min(4, folders.length)}, async () => {
        while (next < folders.length && active) {
          const folder = await api.writableFolder(folders[next++]);
          writable ||= folder.effective_permission === 'write';
        }
      }));
      if (active) {setCanWrite(writable);}
    }
    check().catch(error => {if (active) {setPermissionError(operationError(error));}})
      .finally(() => {if (active) {setChecking(false);}});
    return () => {active = false;};
  }, [api, folderKey]);
  const owners = new Set(photos.map(photo => photo.owner_id));
  const owner = owners.size === 1 ? photos[0]?.owner_id : undefined;
  async function perform() {
    if (lock.current || !photos.length || !mode || (mode === 'move' && !target)) {return;}
    lock.current = true; setBusy(true); setFailures([]);
    const ids = photos.map(photo => photo.id);
    const result = mode === 'delete' ? await runBatches(ids, async chunk => {
      const batch = await api.deletePhotos(chunk);
      return {completed_ids: batch.deleted_ids, failed: batch.failed};
    }) : await moveSelected(ids, id => api.movePhoto(id, target!.id, rename ? 'rename' : 'reject'));
    completed(result.completed_ids);
    retain?.(result.failed.map(failure => failure.id));
    setFailures(result.failed); setMode(null); setBusy(false); lock.current = false;
    if (!result.failed.length) {close();}
  }
  return <View>
    <View style={ui.row}>
      <Text style={ui.copy}>已选 {photos.length} 项</Text>
      <Action label="移动" disabled={busy || checking || !canWrite || !photos.length || owners.size !== 1} onPress={() => {setMode('move'); setTarget(null); setRename(false);}} />
      <Action label="删除" danger disabled={busy || checking || !canWrite || !photos.length} onPress={() => setMode('delete')} />
      <Action label="取消选择" disabled={busy} onPress={close} />
    </View>
    {checking ? <ActivityIndicator /> : permissionError ? <Text accessibilityRole="alert" style={ui.error}>{permissionError}</Text> : photos.length && !canWrite ? <Text style={ui.copy}>所选照片只读，无法移动或删除。</Text> : null}
    {owners.size > 1 ? <Text style={ui.copy}>移动时请选择同一所有者的照片。</Text> : null}
    {busy ? <ActivityIndicator /> : null}
    {failures.length ? <ScrollView style={ui.failures}><Text accessibilityRole="alert" style={ui.error}>{failures.length} 项未完成，已保留供重试。只读照片无法移动或删除。</Text>
      {failures.map(failure => <Text key={failure.id} style={ui.error}>{photos.find(photo => photo.id === failure.id)?.filename ?? failure.id}：{operationError(failure.code)}</Text>)}</ScrollView> : null}
    {mode ? <Sheet title={mode === 'delete' ? '移入回收站？' : '移动照片'} close={() => setMode(null)} busy={busy}>
      {mode === 'delete' ? <Text style={ui.copy}>将 {photos.length} 项移入回收站，可在到期前恢复。</Text> : <>
        <Text style={ui.copy}>只能移动到照片所有者的可写目录。</Text>
        <Action label={target ? `目标：${target.name}` : '选择目标目录'} onPress={() => setChoosing(true)} disabled={busy} />
        <Action label={rename ? '同名时自动改名：开' : '同名时自动改名：关'} selected={rename} onPress={() => setRename(value => !value)} disabled={busy} />
      </>}
      <Text style={ui.copy}>操作受服务端权限校验；失败项目会保留。</Text>
      <Action label={mode === 'delete' ? '确认移入回收站' : '确认移动'} danger={mode === 'delete'} disabled={busy || (mode === 'move' && !target)} onPress={perform} />
    </Sheet> : null}
    {choosing ? <FolderPicker api={api} ownerId={owner} close={() => setChoosing(false)} choose={folder => {setTarget(folder); setChoosing(false);}} /> : null}
  </View>;
}
