import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Image, PermissionsAndroid, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, spacing } from '../../components/theme';
import { Message, PrimaryButton, Screen } from '../../components/ui';
import NativePhotoPicker, { type Spec as PhotoPickerSpec } from '../../native/NativePhotoPicker';
import type { PickedMedia } from '../../native/NativeUploadQueue';
import { credentialsStore } from '../../services/credentials';
import type { ApiClient } from '../../services/api/client';
import type { User } from '../../services/api/types';
import type { ServerConfig } from '../../services/connection/types';
import { FolderPickerScreen } from '../folders/FolderPickerScreen';
import { pairPickedMedia, pickedMediaUris, uploadQueue, type UploadQueueService } from './uploadService';
import type { UploadQueueSnapshot, UploadTask } from './types';
import '../../i18n';

export type UploadScreenProps = {
  api: Pick<ApiClient, 'listFolders' | 'getFolder'>;
  server: ServerConfig;
  user: User;
  queue?: UploadQueueService;
  picker?: Pick<PhotoPickerSpec, 'pick' | 'release'>;
  notificationsAllowed?: boolean;
  notificationPermission?: () => Promise<boolean>;
  concurrency?: 1 | 2 | 3 | 4;
  cellularUploadEnabled?: boolean;
  lanCIDRs?: readonly string[];
  isFocused?: boolean;
  onUploadStarted?: () => void | Promise<void>;
};

const EMPTY_SNAPSHOT: UploadQueueSnapshot = {
  tasks: [],
  queued: 0,
  uploading: 0,
  succeeded: 0,
  failed: 0,
  sentBytes: 0,
  totalBytes: 0,
};

const unavailablePicker: Pick<PhotoPickerSpec, 'pick' | 'release'> = {
  pick: async () => { throw new Error('NativePhotoPicker is unavailable'); },
  release: async () => undefined,
};

function nativeNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || Platform.Version < 33) return Promise.resolve(true);
  return PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
}

function taskStateLabel(task: UploadTask, t: (key: string, fallback: string) => string): string {
  if (task.state === 'succeeded' && task.lastErrorCode === 'DUPLICATE_PHOTO') {
    return t('upload.skipped', '已跳过');
  }
  switch (task.state) {
    case 'queued': return t('upload.queued', '排队中');
    case 'uploading': return t('upload.uploading', '进行中');
    case 'paused': return t('upload.paused', '已暂停');
    case 'succeeded': return t('upload.succeeded', '已完成');
    case 'failed': return t('upload.failed', '失败');
    case 'canceled': return t('upload.canceled', '已取消');
    default: return task.state;
  }
}

function formatSize(size: number | null): string {
  if (size === null) return '';
  return size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

async function requestNativeNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || Platform.Version < 33) return true;
  try {
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    return result === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

export function UploadScreen({
  api,
  server,
  user,
  queue = uploadQueue,
  picker = NativePhotoPicker ?? unavailablePicker,
  notificationsAllowed = true,
  notificationPermission,
  concurrency = 2,
  cellularUploadEnabled = false,
  lanCIDRs = [],
  isFocused = true,
  onUploadStarted,
}: UploadScreenProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<readonly PickedMedia[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<UploadQueueSnapshot>(EMPTY_SNAPSHOT);
  const [deviceId, setDeviceId] = useState(user.id);
  const [notificationPermissionGranted, setNotificationPermissionGranted] = useState(notificationsAllowed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedRef = useRef<readonly PickedMedia[]>([]);
  const ownedUrisRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  const focusedRef = useRef(isFocused);
  const enqueueInFlightRef = useRef(false);
  focusedRef.current = isFocused;

  const releaseUris = useCallback(async (uris: readonly string[]) => {
    if (uris.length === 0) return;
    await picker.release(uris).catch(() => undefined);
  }, [picker]);

  const releaseOwnedUris = useCallback(async () => {
    const uris = Array.from(ownedUrisRef.current);
    ownedUrisRef.current.clear();
    selectedRef.current = [];
    if (mountedRef.current) setSelected([]);
    await releaseUris(uris);
  }, [releaseUris]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (!enqueueInFlightRef.current) {
        releaseOwnedUris().catch(() => undefined);
      }
    };
  }, [releaseOwnedUris]);

  useEffect(() => {
    if (isFocused) return;
    if (!enqueueInFlightRef.current) {
      releaseOwnedUris().catch(() => undefined);
    }
  }, [isFocused, releaseOwnedUris]);

  useEffect(() => {
    let mounted = true;
    const permission = notificationsAllowed === false
      ? Promise.resolve(false)
      : notificationPermission?.() ?? nativeNotificationPermission();
    permission
      .then((allowed) => {
        if (mounted) setNotificationPermissionGranted(allowed);
      })
      .catch(() => {
        if (mounted) setNotificationPermissionGranted(false);
      });
    return () => { mounted = false; };
  }, [notificationPermission, notificationsAllowed]);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await queue.snapshot(server.id));
    } catch (caught) {
      if (caught instanceof Error) setError(caught.message);
    }
  }, [queue, server.id]);

  const ensureNotificationPermission = async (): Promise<boolean> => {
    if (notificationsAllowed === false || notificationPermission) return notificationPermissionGranted;
    const allowed = await requestNativeNotificationPermission();
    setNotificationPermissionGranted(allowed);
    return allowed;
  };

  useEffect(() => {
    let mounted = true;
    credentialsStore.get(server.id).then((credentials) => {
      if (mounted && credentials?.deviceId) setDeviceId(credentials.deviceId);
    }).catch(() => undefined);
    refresh().catch(() => undefined);
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') refresh().catch(() => undefined);
    }, 1_000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh().catch(() => undefined);
    });
    return () => {
      mounted = false;
      clearInterval(timer);
      subscription.remove();
    };
  }, [refresh, server.id]);

  const chooseMedia = async () => {
    setError(null);
    setBusy(true);
    try {
      const items = await picker.pick();
      const paired = pairPickedMedia(items);
      if (!mountedRef.current || !focusedRef.current) {
        await releaseUris(pickedMediaUris(paired));
        return;
      }
      await releaseOwnedUris();
      if (!mountedRef.current || !focusedRef.current) {
        await releaseUris(pickedMediaUris(paired));
        return;
      }
      selectedRef.current = paired;
      ownedUrisRef.current = new Set(pickedMediaUris(paired));
      setSelected(paired);
      setFolderId(null);
      setFolderName(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('upload.pickerError', '无法读取所选媒体'));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const chooseFolder = (id: string) => {
    setFolderId(id);
    setFolderName(id);
    setFolderPickerOpen(false);
    api.getFolder(id).then((folder) => setFolderName(folder.name)).catch(() => undefined);
  };

  const folderPicker = folderPickerOpen ? (
    <FolderPickerScreen
      api={api}
      serverId={server.id}
      userId={user.id}
      role={user.role}
      onSelectFolder={chooseFolder}
      onCancel={() => setFolderPickerOpen(false)}
    />
  ) : null;

  const startUpload = async () => {
    if (selected.length === 0 || !folderId) return;
    setError(null);
    setBusy(true);
    let enqueued = false;
    try {
      await ensureNotificationPermission();
      if (!mountedRef.current || !focusedRef.current) return;
      enqueueInFlightRef.current = true;
      await queue.enqueue(server.id, deviceId, folderId, selected);
      enqueueInFlightRef.current = false;
      enqueued = true;
      ownedUrisRef.current.clear();
      selectedRef.current = [];
      setSelected([]);
      await queue.start?.(server.id, server.baseURL, deviceId, concurrency, cellularUploadEnabled, lanCIDRs);
      setFolderId(null);
      setFolderName(null);
      await refresh();
      await onUploadStarted?.();
    } catch (caught) {
      enqueueInFlightRef.current = false;
      if (!enqueued) await releaseOwnedUris();
      if (!mountedRef.current) return;
      setError(caught instanceof Error ? caught.message : t('upload.startError', '上传无法开始'));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const pause = async () => {
    await queue.pause(server.id);
    await refresh();
  };

  const resume = async () => {
    await queue.resume(server.id);
    await queue.start?.(server.id, server.baseURL, deviceId, concurrency, cellularUploadEnabled, lanCIDRs);
    await refresh();
  };

  const retryFailed = async () => {
    await queue.retryFailed(server.id);
    await queue.start?.(server.id, server.baseURL, deviceId, concurrency, cellularUploadEnabled, lanCIDRs);
    await refresh();
  };

  const cancelTask = (task: UploadTask) => {
    Alert.alert(
      t('upload.cancelTitle', '移除上传任务？'),
      t('upload.cancelMessage', '该任务尚未完成，确认后会从本机队列移除。'),
      [
        { text: t('common.cancel', '取消'), style: 'cancel' },
        {
          text: t('upload.remove', '移除'),
          style: 'destructive',
          onPress: () => {
            queue.cancel([task.id]).then(() => refresh()).catch(() => undefined);
          },
        },
      ],
    );
  };

  const percent = useMemo(() => (
    snapshot.totalBytes > 0
      ? Math.round(Math.min(1, snapshot.sentBytes / snapshot.totalBytes) * 100)
      : null
  ), [snapshot.sentBytes, snapshot.totalBytes]);

  if (folderPicker) return folderPicker;

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.title}>{t('tabs.upload', '上传')}</Text>
      </View>

      {!notificationPermissionGranted ? (
        <Message warning>{t('upload.notificationWarning', '通知权限未开启：切到后台后无法看到上传进度，请在系统设置中允许通知。')}</Message>
      ) : null}
      {error ? <Message>{error}</Message> : null}

      <PrimaryButton
        label={t('upload.pick', '选择照片或视频')}
        loading={busy && selected.length === 0}
        disabled={busy}
        onPress={() => { chooseMedia().catch(() => undefined); }}
      />
      {selected.length > 0 ? (
        <View style={styles.taskList}>
          <Text style={styles.selection}>{t('upload.selected', `已选择 ${selected.length} 项`, { count: selected.length })}</Text>
          {selected.map((item) => (
            <View key={item.uri} style={styles.taskRow}>
              {item.mimeType.startsWith('image/') ? <Image source={{ uri: item.uri }} style={styles.taskThumbnail} /> : <View style={styles.taskThumbnail}><Text style={styles.videoMark}>▶</Text></View>}
              <View style={styles.taskCopy}>
                <Text style={styles.taskName} numberOfLines={1}>{item.displayName}</Text>
                {item.size !== null ? <Text style={styles.meta}>{formatSize(item.size)}</Text> : null}
              </View>
            </View>
          ))}
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('upload.chooseFolder', '选择目标文件夹')}
        disabled={selected.length === 0}
        onPress={() => setFolderPickerOpen(true)}
        style={({ pressed }) => [styles.folderButton, selected.length === 0 && styles.disabled, pressed && styles.pressed]}
      >
        <Text style={styles.folderButtonText}>{folderName ? `${t('upload.target', '目标文件夹')}：${folderName}` : t('upload.chooseFolder', '选择目标文件夹')}</Text>
      </Pressable>

      <PrimaryButton
        label={t('upload.start', '开始上传')}
        loading={busy && selected.length > 0}
        disabled={busy || selected.length === 0 || !folderId}
        onPress={() => { startUpload().catch(() => undefined); }}
      />

      <View accessible accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: percent ?? 0 }} style={styles.progressBlock}>
        <View style={styles.progressHeader}>
          <Text style={styles.sectionTitle}>{t('upload.queue', '上传队列')}</Text>
          <Text style={styles.progressText}>{percent === null ? t('upload.unknownProgress', '准备中') : `${percent}%`}</Text>
        </View>
        <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${percent ?? 0}%` }]} /></View>
        <Text style={styles.meta}>{snapshot.uploading} {t('upload.uploading', '进行中')} · {snapshot.queued} {t('upload.queued', '排队中')} · {snapshot.succeeded} {t('upload.succeeded', '已完成')}</Text>
      </View>

      {snapshot.tasks.length > 0 ? (
        <View accessibilityLabel={t('upload.taskList', '上传任务')} style={styles.taskList}>
          {snapshot.tasks.map((task) => {
            const canCancel = task.state === 'queued' || task.state === 'paused' || task.state === 'failed';
            return (
              <View key={task.id} style={styles.taskRow}>
                {task.mimeType.startsWith('image/') ? <Image source={{ uri: task.contentUri }} style={styles.taskThumbnail} /> : <View style={styles.taskThumbnail}><Text style={styles.videoMark}>▶</Text></View>}
                <View style={styles.taskCopy}>
                  <Text style={styles.taskName} numberOfLines={1}>{task.displayName}</Text>
                  <View style={styles.taskMeta}>
                    {task.size !== null ? <Text style={styles.meta}>{formatSize(task.size)} · </Text> : null}
                    <Text style={styles.meta}>{taskStateLabel(task, t)}</Text>
                  </View>
                  {task.state === 'uploading' && task.size ? <View style={styles.taskTrack}><View style={[styles.progressFill, { width: `${Math.min(100, Math.round(task.sentBytes / task.size * 100))}%` }]} /></View> : null}
                </View>
                {canCancel ? (
                  <PrimaryButton
                    label={`${t('upload.cancel', '取消')} ${task.displayName}`}
                    onPress={() => cancelTask(task)}
                  />
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}

      {snapshot.failed > 0 ? (
        <View style={styles.failureBlock}>
          <Text style={styles.failureText}>{t('upload.failedCount', `有 ${snapshot.failed} 项失败`, { count: snapshot.failed })}</Text>
          <PrimaryButton label={t('upload.retryFailed', '重试失败项')} onPress={() => { retryFailed().catch(() => undefined); }} />
        </View>
      ) : null}
      {snapshot.uploading > 0 ? <PrimaryButton label={t('upload.pause', '暂停上传')} onPress={() => { pause().catch(() => undefined); }} /> : null}
      {snapshot.tasks.some((task: UploadTask) => task.state === 'paused') ? <PrimaryButton label={t('upload.resume', '继续上传')} onPress={() => { resume().catch(() => undefined); }} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing.xs },
  title: { color: colors.ink, fontSize: 23, fontWeight: '700' },
  selection: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  folderButton: { minHeight: 56, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  folderButtonText: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  pressed: { backgroundColor: colors.warningBackground },
  progressBlock: { gap: spacing.xs, paddingVertical: spacing.md, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.border },
  progressHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  progressText: { color: colors.accent, fontSize: 16, fontWeight: '800' },
  progressTrack: { height: 8, overflow: 'hidden', borderRadius: 4, backgroundColor: colors.border },
  progressFill: { height: '100%', borderRadius: 4, backgroundColor: colors.accent },
  meta: { color: colors.muted, fontSize: 13 },
  failureBlock: { gap: spacing.sm },
  failureText: { color: colors.error, fontSize: 15, fontWeight: '700' },
  taskList: { gap: spacing.xs },
  taskRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xs, borderBottomWidth: 1, borderColor: colors.border },
  taskThumbnail: { width: 48, height: 48, borderRadius: 4, backgroundColor: colors.input, alignItems: 'center', justifyContent: 'center' },
  videoMark: { color: colors.muted },
  taskTrack: { height: 4, borderRadius: 2, backgroundColor: colors.border, overflow: 'hidden', marginTop: spacing.xs },
  taskCopy: { flex: 1, gap: 2 },
  taskMeta: { flexDirection: 'row' },
  taskName: { color: colors.ink, fontSize: 15, fontWeight: '700' },
});
