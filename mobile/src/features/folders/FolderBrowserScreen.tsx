import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { colors, spacing } from '../../components/theme';
import { Message, Screen } from '../../components/ui';
import type { ApiClient } from '../../services/api/client';
import type { Folder } from '../../services/api/types';
import { folderListQueryOptions, type FolderQueryApi } from '../gallery/queries';
import '../../i18n';

export type FolderBrowserScreenProps = {
  api: Pick<ApiClient, 'listFolders' | 'getFolder'>;
  serverId: string;
  userId: string;
  onFolderPress?: (folder: Folder) => void;
  onBack?: () => void;
};

type Breadcrumb = { id?: string; name: string };

export function FolderBrowserScreen({
  api,
  serverId,
  userId,
  onFolderPress,
  onBack,
}: FolderBrowserScreenProps) {
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
      onBack?.();
      return;
    }
    setBreadcrumbs((items) => items.slice(0, -1));
  };

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.title}>{t('folders.title', '文件夹')}</Text>
        {breadcrumbs.length > 0 ? (
          <Pressable accessibilityRole="button" accessibilityLabel={t('common.back', '返回')} onPress={goBack} style={styles.backButton}>
            <Text style={styles.backText}>‹ {t('common.back', '返回')}</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.breadcrumb}>{breadcrumbs.map(({ name }) => name).join(' / ') || t('folders.root', '全部文件夹')}</Text>
      {query.isPending ? <ActivityIndicator accessibilityLabel={t('common.loading', '加载中')} color={colors.accent} /> : null}
      {query.isError ? <Message>{t('folders.error', '文件夹加载失败')}</Message> : null}
      {!query.isPending && !query.isError && query.data.items.length === 0 ? (
        <Text style={styles.empty}>{t('folders.empty', '这里还没有文件夹')}</Text>
      ) : null}
      {query.data?.items.map((folder) => (
        <Pressable
          key={folder.id}
          testID={`folder-${folder.id}`}
          accessibilityRole="button"
          onPress={() => {
            onFolderPress?.(folder);
            setBreadcrumbs((items) => [...items, { id: folder.id, name: folder.name }]);
          }}
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        >
          <View style={styles.rowCopy}>
            <Text style={styles.folderName}>{folder.name}</Text>
            <Text style={styles.meta}>
              {folder.photo_count} {t('folders.photos', '张照片')} · {folder.child_folder_count} {t('folders.children', '个子文件夹')}
            </Text>
          </View>
          {folder.inherited_permission === 'read' ? <Text style={styles.readOnly}>{t('folders.readOnly', '只读')}</Text> : null}
          <Text style={styles.chevron}>›</Text>
        </Pressable>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.ink, fontSize: 26, fontWeight: '800' },
  backButton: { minHeight: 48, justifyContent: 'center', paddingHorizontal: spacing.sm },
  backText: { color: colors.accent, fontSize: 16, fontWeight: '700' },
  breadcrumb: { color: colors.muted, fontSize: 14 },
  empty: { color: colors.muted, paddingVertical: spacing.lg },
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
  pressed: { backgroundColor: colors.warningBackground },
  rowCopy: { flex: 1, gap: 4 },
  folderName: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  meta: { color: colors.muted, fontSize: 13 },
  readOnly: { color: colors.warningInk, fontSize: 13, fontWeight: '700' },
  chevron: { color: colors.accent, fontSize: 26 },
});
