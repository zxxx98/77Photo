import React, { useEffect, useMemo } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { FlashList, type ListRenderItem } from '@shopify/flash-list';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { colors, spacing } from '../../components/theme';
import { Message, PrimaryButton } from '../../components/ui';
import type { ApiClient } from '../../services/api/client';
import type { Photo } from '../../services/api/types';
import { AuthenticatedImage } from './AuthenticatedImage';
import {
  appendPhotoPages,
  CursorExpiredError,
  groupPhotosByLocalDay,
  photoKeys,
  photoListQueryOptions,
} from './queries';

export type GalleryScreenProps = {
  api: Pick<ApiClient, 'listPhotos' | 'thumbnailURL'>;
  serverId: string;
  userId: string;
  folderId?: string;
  timeZone?: string;
  thumbnailSize?: 256 | 512;
  onPhotoPress?: (photo: Photo) => void;
};

type GalleryRow =
  | { type: 'day'; key: string }
  | { type: 'photo'; photo: Photo };

function rowsForPhotos(photos: Photo[], timeZone: string): GalleryRow[] {
  const byId = new Map(photos.map((item) => [item.id, item]));
  return groupPhotosByLocalDay(photos, timeZone).flatMap((group) => [
    { type: 'day' as const, key: group.key },
    ...group.ids.flatMap((id) => {
      const item = byId.get(id);
      return item ? [{ type: 'photo' as const, photo: item }] : [];
    }),
  ]);
}

export function GalleryScreen({
  api,
  serverId,
  userId,
  folderId,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  thumbnailSize = 256,
  onPhotoPress,
}: GalleryScreenProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const options = useMemo(
    () => photoListQueryOptions({ api, serverId, userId, folderId }),
    [api, folderId, serverId, userId],
  );
  const query = useInfiniteQuery(options);

  useEffect(() => {
    if (!(query.error instanceof CursorExpiredError)) return;
    queryClient.resetQueries({ queryKey: photoKeys.list(serverId, userId, folderId), exact: true }).catch(() => undefined);
  }, [folderId, query.error, queryClient, serverId, userId]);

  const photos = useMemo(() => appendPhotoPages(query.data?.pages ?? []), [query.data?.pages]);
  const rows = useMemo(() => rowsForPhotos(photos, timeZone), [photos, timeZone]);
  const renderItem: ListRenderItem<GalleryRow> = ({ item }) => {
    if (item.type === 'day') {
      return <Text style={styles.dayHeader}>{item.key}</Text>;
    }
    return (
      <View style={styles.photoCell}>
        <AuthenticatedImage
          testID={`photo-${item.photo.id}`}
          accessibilityLabel={item.photo.filename}
          accessible
          uri={api.thumbnailURL(item.photo.id, thumbnailSize)}
          serverId={serverId}
          userId={userId}
          style={styles.thumbnail}
          resizeMode="cover"
          onError={() => undefined}
        />
        <Pressable
          accessible
          accessibilityRole="button"
          accessibilityLabel={item.photo.filename}
          onPress={() => onPhotoPress?.(item.photo)}
          style={styles.photoHitTarget}
        />
      </View>
    );
  };

  if (query.isPending && !query.data) {
    return <View style={styles.center}><ActivityIndicator color={colors.accent} /><Text>{t('gallery.loading', '正在加载照片…')}</Text></View>;
  }
  if (query.isError && !query.data) {
    return (
      <View style={styles.center}>
        <Message>{t('gallery.error', '照片加载失败')}</Message>
        <PrimaryButton label={t('common.retry', '重试')} onPress={() => { query.refetch().catch(() => undefined); }} />
      </View>
    );
  }
  if (rows.length === 0) {
    return <View style={styles.center}><Text style={styles.empty}>{t('gallery.empty', '还没有照片')}</Text></View>;
  }

  return (
    <View style={styles.container}>
      <FlashList
        data={rows}
        renderItem={renderItem}
        keyExtractor={(item) => item.type === 'day' ? `day-${item.key}` : item.photo.id}
        getItemType={(item) => item.type}
        overrideItemLayout={(layout, item) => {
          if (item.type === 'day') layout.span = 3;
        }}
        numColumns={3}
        onEndReached={() => {
          if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage().catch(() => undefined);
        }}
        onEndReachedThreshold={0.5}
        onRefresh={() => { query.refetch().catch(() => undefined); }}
        refreshing={query.isRefetching && !query.isFetchingNextPage}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching && !query.isFetchingNextPage}
            onRefresh={() => { query.refetch().catch(() => undefined); }}
            tintColor={colors.accent}
          />
        }
        contentContainerStyle={styles.listContent}
        extraData={thumbnailSize}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  listContent: { padding: spacing.sm },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.background,
  },
  empty: { color: colors.muted, fontSize: 17 },
  dayHeader: {
    width: '100%',
    color: colors.ink,
    fontSize: 17,
    fontWeight: '800',
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.sm,
  },
  photoCell: {
    flex: 1,
    aspectRatio: 1,
    margin: 2,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  thumbnail: { width: '100%', height: '100%' },
  photoHitTarget: { ...StyleSheet.absoluteFill },
});
