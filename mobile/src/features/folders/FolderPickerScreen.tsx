import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { colors, spacing } from '../../components/theme';
import { Message, Screen } from '../../components/ui';
import type { ApiClient } from '../../services/api/client';
import type { Folder, User } from '../../services/api/types';
import { folderListQueryOptions, type FolderQueryApi } from '../gallery/queries';
import '../../i18n';

export type FolderPickerScreenProps = {
  api: Pick<ApiClient, 'listFolders' | 'getFolder'>;
  serverId: string;
  userId: string;
  role?: User['role'];
  onSelectFolder: (folderId: string) => void;
  onCancel?: () => void;
};

export function isWritableFolder(folder: Folder, userId: string, role: User['role'] = 'user'): boolean {
  return role === 'admin' || folder.owner_id === userId || folder.inherited_permission === 'write';
}

type Breadcrumb = { id?: string; name: string };

export function FolderPickerScreen({
  api,
  serverId,
  userId,
  role,
  onSelectFolder,
  onCancel,
}: FolderPickerScreenProps) {
  const { t } = useTranslation();
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const currentFolderId = breadcrumbs[breadcrumbs.length - 1]?.id;
  const options = useMemo(
    () => folderListQueryOptions(api as FolderQueryApi, serverId, userId, currentFolderId),
    [api, currentFolderId, serverId, userId],
  );
  const query = useQuery(options);
  const goBack = () => {
    if (breadcrumbs.length === 0) {
      onCancel?.();
      return;
    }
    setBreadcrumbs((items) => items.slice(0, -1));
  };

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.title}>{t('folders.choose', '选择文件夹')}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t('common.back', '返回')} onPress={goBack} style={styles.backButton}>
          <Text style={styles.backText}>{breadcrumbs.length ? '‹ ' : ''}{t('common.back', '返回')}</Text>
        </Pressable>
      </View>
      {query.isPending ? <ActivityIndicator accessibilityLabel={t('common.loading', '加载中')} color={colors.accent} /> : null}
      {query.isError ? <Message>{t('folders.error', '文件夹加载失败')}</Message> : null}
      {query.data?.items.map((folder) => {
        const writable = isWritableFolder(folder, userId, role);
        return (
          <Pressable
            key={folder.id}
            testID={`folder-picker-${folder.id}`}
            accessibilityRole="button"
            accessibilityState={{ disabled: !writable }}
            disabled={!writable}
            onPress={() => onSelectFolder(folder.id)}
            onLongPress={() => setBreadcrumbs((items) => [...items, { id: folder.id, name: folder.name }])}
            style={({ pressed }) => [styles.row, !writable && styles.disabled, pressed && writable && styles.pressed]}
          >
            <View style={styles.rowCopy}>
              <Text style={styles.folderName}>{folder.name}</Text>
              <Text style={styles.meta}>{writable ? t('folders.writable', '可写') : t('folders.readOnly', '只读')}</Text>
            </View>
            <Text style={styles.chevron}>{writable ? '✓' : '—'}</Text>
          </Pressable>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.ink, fontSize: 26, fontWeight: '800' },
  backButton: { minHeight: 48, justifyContent: 'center', paddingHorizontal: spacing.sm },
  backText: { color: colors.accent, fontSize: 16, fontWeight: '700' },
  row: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  disabled: { opacity: 0.55 },
  pressed: { backgroundColor: colors.warningBackground },
  rowCopy: { flex: 1, gap: 4 },
  folderName: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  meta: { color: colors.muted, fontSize: 13 },
  chevron: { color: colors.accent, fontSize: 20, fontWeight: '800' },
});
