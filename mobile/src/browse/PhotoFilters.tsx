import React, {useState} from 'react';
import {Text, TextInput, View} from 'react-native';
import {BrowseApi, type Folder, type PhotoFilters as ApiFilters} from './api';
import {Action, FolderPicker, Sheet, ui} from './ManagementUI';
import {dateBoundary, operationError} from './management';

export type GalleryFilters = {q: string; mediaType: '' | 'photo' | 'video'; fromDate: string; toDate: string; folder?: Folder};
export const emptyFilters: GalleryFilters = {q: '', mediaType: '', fromDate: '', toDate: ''};
export function queryFilters(filters: GalleryFilters): ApiFilters {
  if (filters.fromDate && filters.toDate && filters.fromDate > filters.toDate) {throw new Error('开始日期不能晚于结束日期');}
  return {q: filters.q.trim(), mediaType: filters.mediaType, from: dateBoundary(filters.fromDate), to: dateBoundary(filters.toDate, true)};
}
export function hasFilters(filters: GalleryFilters): boolean {
  return !!(filters.q.trim() || filters.mediaType || filters.fromDate || filters.toDate || filters.folder);
}
export default function PhotoFilters({api, value, apply, close}: {api: BrowseApi; value: GalleryFilters; apply: (filters: GalleryFilters) => void; close: () => void}) {
  const [draft, setDraft] = useState(value);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState('');
  function submit() {
    try {queryFilters(draft); apply({...draft, q: draft.q.trim()}); close();}
    catch (e) {setError(operationError(e));}
  }
  return <>
    <Sheet title="搜索与筛选" close={close}>
      <Text style={ui.copy}>文件名</Text>
      <TextInput accessibilityLabel="搜索文件名" value={draft.q} onChangeText={q => setDraft(old => ({...old, q}))} maxLength={100} placeholder="输入文件名" style={ui.input} />
      <View style={ui.row}>{(['', 'photo', 'video'] as const).map(mediaType => <Action key={mediaType} label={mediaType === '' ? '全部类型' : mediaType === 'photo' ? '照片' : '视频'} selected={draft.mediaType === mediaType} onPress={() => setDraft(old => ({...old, mediaType}))} />)}</View>
      <Text style={ui.copy}>拍摄日期（YYYY-MM-DD，包含结束当天）</Text>
      <TextInput accessibilityLabel="开始日期" value={draft.fromDate} onChangeText={fromDate => setDraft(old => ({...old, fromDate}))} placeholder="开始日期，如 2026-09-01" maxLength={10} style={ui.input} />
      <TextInput accessibilityLabel="结束日期" value={draft.toDate} onChangeText={toDate => setDraft(old => ({...old, toDate}))} placeholder="结束日期，如 2026-09-30" maxLength={10} style={ui.input} />
      <Action label={draft.folder ? `文件夹：${draft.folder.name}` : '所有文件夹'} onPress={() => setChoosing(true)} />
      {draft.folder ? <Action label="移除文件夹筛选" onPress={() => setDraft(old => ({...old, folder: undefined}))} /> : null}
      {error ? <Text accessibilityRole="alert" style={ui.error}>{error}</Text> : null}
      <View style={ui.row}><Action label="清除筛选" onPress={() => {setDraft(emptyFilters); setError('');}} /><Action label="应用筛选" onPress={submit} /></View>
    </Sheet>
    {choosing ? <FolderPicker api={api} writable={false} close={() => setChoosing(false)} choose={folder => {setDraft(old => ({...old, folder})); setChoosing(false);}} /> : null}
  </>;
}
