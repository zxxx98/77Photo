import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { colors, spacing } from '../../components/theme';
import { Message } from '../../components/ui';
import type { ApiClient } from '../../services/api/client';
import type { Folder, Photo } from '../../services/api/types';
import { GalleryScreen } from '../gallery/GalleryScreen';
import { folderListQueryOptions, type FolderQueryApi } from '../gallery/queries';
import '../../i18n';

export type FolderBrowserScreenProps = {
  api: Pick<ApiClient, 'listFolders' | 'getFolder' | 'listPhotos' | 'thumbnailURL'>;
  serverId: string;
  userId: string;
  onFolderPress?: (folder: Folder) => void;
  onPhotoPress?: (photo: Photo, photos: readonly Photo[]) => void;
  onBack?: () => void;
};

type Breadcrumb = { id?: string; name: string };

export function FolderBrowserScreen({
  api,
  serverId,
  userId,
  onFolderPress,
  onPhotoPress,
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

  const folderRows = query.data?.items.map((folder) => (
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
      <Text style={styles.folderIcon}>▱</Text>
      <View style={styles.rowCopy}>
        <Text style={styles.folderName}>{folder.name}</Text>
        <Text style={styles.meta}>
          {folder.photo_count} {t('folders.photos', '张照片')} · {folder.child_folder_count} {t('folders.children', '个子文件夹')}
        </Text>
      </View>
      {folder.inherited_permission === 'read' ? <Text style={styles.readOnly}>{t('folders.readOnly', '只读')}</Text> : null}
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  ));

  const content = (
    <>
      <View testID="folder-browser-header" style={styles.header}>
        <Text style={styles.title}>{t('folders.title', '文件夹')}</Text>
        {currentFolderId ? (
          <Pressable accessibilityRole="button" accessibilityLabel={t('common.back', '返回')} onPress={goBack} style={styles.backButton}>
            <Text style={styles.backText}>‹ {t('common.back', '返回')}</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.breadcrumb}>
        {currentFolderId ? breadcrumbs.map(({ name }) => name).join(' / ') : t('folders.root', '全部文件夹')}
      </Text>
      {query.isPending ? <ActivityIndicator accessibilityLabel={t('common.loading', '加载中')} color={colors.accent} /> : null}
      {query.isError ? <Message>{t('folders.error', '文件夹加载失败')}</Message> : null}
      {!query.isPending && !query.isError && query.data.items.length === 0 ? (
        <Text style={styles.empty}>
          {currentFolderId ? t('folders.emptyChildren', '这里还没有子文件夹') : t('folders.empty', '这里还没有文件夹')}
        </Text>
      ) : null}
      {folderRows}
    </>
  );

  if (currentFolderId) {
    return (
      <SafeAreaView style={styles.folderContent} edges={['top', 'left', 'right']}>
        <GalleryScreen
          api={api}
          serverId={serverId}
          userId={userId}
          folderId={currentFolderId}
          groupByDay={false}
          listHeaderComponent={content}
          onPhotoPress={onPhotoPress}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.folderContent} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.rootContent}>
        {content}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  folderContent: { flex: 1, backgroundColor: colors.background },
  rootContent: { flexGrow: 1, paddingHorizontal: 20, paddingVertical: spacing.lg, gap: spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.ink, fontSize: 23, fontWeight: '700' },
  backButton: { minHeight: 48, minWidth: 72, justifyContent: 'center', alignItems: 'flex-end', paddingHorizontal: spacing.sm },
  backText: { color: colors.accent, fontSize: 16, fontWeight: '700' },
  breadcrumb: { color: colors.muted, fontSize: 14 },
  empty: { color: colors.muted, paddingVertical: spacing.lg },
  row: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: 8,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  folderIcon: { color: colors.accent, fontSize: 24, width: 30 },
  pressed: { backgroundColor: colors.warningBackground },
  rowCopy: { flex: 1, gap: 4 },
  folderName: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  meta: { color: colors.muted, fontSize: 13 },
  readOnly: { color: colors.warningInk, fontSize: 13, fontWeight: '700' },
  chevron: { color: colors.accent, fontSize: 26 },
});
