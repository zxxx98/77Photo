import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  BackHandler,
  FlatList,
  Linking,
  Modal,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { PinchGestureHandler, State, type PinchGestureHandlerStateChangeEvent } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import Video from 'react-native-video';

import { colors, spacing } from '../../components/theme';
import { PrimaryButton } from '../../components/ui';
import type { ApiClient } from '../../services/api/client';
import type { Photo } from '../../services/api/types';
import { AuthenticatedImage } from '../gallery/AuthenticatedImage';
import { MediaDetailsSheet } from './MediaDetailsSheet';
import '../../i18n';

export type MediaViewerScreenProps = {
  api: Pick<ApiClient, 'previewURL' | 'originalURL' | 'getAuthHeaders' | 'createShareLink' | 'deletePhoto'>;
  photos: readonly Photo[];
  initialIndex?: number;
  serverId?: string;
  userId?: string;
  onClose?: () => void;
  onDeleted?: (photoId: string) => void;
};

function isPlayableVideo(photo: Photo): boolean {
  return photo.mime_type === 'video/mp4' || photo.mime_type === 'video/webm';
}

export function MediaViewerScreen({
  api,
  photos,
  initialIndex = 0,
  serverId,
  userId,
  onClose,
  onDeleted,
}: MediaViewerScreenProps) {
  const { t } = useTranslation();
  const [selectedIndex, setSelectedIndex] = useState(Math.min(Math.max(initialIndex, 0), Math.max(photos.length - 1, 0)));
  const [authHeaders, setAuthHeaders] = useState<Record<string, string>>({});
  const [detailsVisible, setDetailsVisible] = useState(false);
  const [unsupportedPhotoId, setUnsupportedPhotoId] = useState<string | null>(null);
  const lastTap = useRef(0);
  const scale = useRef(new Animated.Value(1)).current;
  const pinchScale = useRef(1);
  const selectedPhoto = photos[selectedIndex];

  useEffect(() => {
    let cancelled = false;
    api.getAuthHeaders().then((headers) => {
      if (!cancelled) setAuthHeaders(headers);
    }).catch(() => {
      if (!cancelled) setAuthHeaders({});
    });
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose?.();
      return Boolean(onClose);
    });
    return () => subscription.remove();
  }, [onClose]);

  useEffect(() => {
    scale.setValue(1);
    pinchScale.current = 1;
    setUnsupportedPhotoId(null);
  }, [scale, selectedIndex]);

  const onDoubleTap = () => {
    const now = Date.now();
    if (now - lastTap.current < 300) {
      Animated.spring(scale, { toValue: pinchScale.current > 1 ? 1 : 2, useNativeDriver: true }).start();
      pinchScale.current = pinchScale.current > 1 ? 1 : 2;
    }
    lastTap.current = now;
  };

  const finishPinch = (event: PinchGestureHandlerStateChangeEvent) => {
    if (event.nativeEvent.oldState !== State.ACTIVE) return;
    const nextScale = Math.min(Math.max(event.nativeEvent.scale, 1), 4);
    pinchScale.current = nextScale;
    Animated.spring(scale, { toValue: nextScale, useNativeDriver: true }).start();
  };

  const shareSelected = async () => {
    if (!selectedPhoto) return;
    try {
      const link = await api.createShareLink({
        resourceType: 'photo',
        resourceId: selectedPhoto.id,
        duration: 'forever',
      });
      await Share.share({ message: link.url });
    } catch {
      // Sharing is best effort; the details sheet remains usable after a cancelled share.
    }
  };

  const deleteSelected = () => {
    if (!selectedPhoto) return;
    Alert.alert(
      t('viewer.confirmDeleteTitle', '永久删除照片？'),
      t('viewer.confirmDeleteMessage', '原文件和索引将被永久删除，此操作无法撤销。'),
      [
        { text: t('common.cancel', '取消'), style: 'cancel' },
        {
          text: t('viewer.delete', '永久删除'),
          style: 'destructive',
          onPress: () => {
            void api.deletePhoto(selectedPhoto.id).then(() => {
              onDeleted?.(selectedPhoto.id);
              setDetailsVisible(false);
              onClose?.();
            });
          },
        },
      ],
    );
  };

  const openOriginal = () => {
    if (selectedPhoto) void Linking.openURL(api.originalURL(selectedPhoto.id));
  };

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const width = event.nativeEvent.layoutMeasurement.width;
    if (width > 0) setSelectedIndex(Math.round(event.nativeEvent.contentOffset.x / width));
  };

  if (!selectedPhoto) {
    return <View style={styles.center}><Text style={styles.empty}>{t('viewer.empty', '没有可查看的媒体')}</Text></View>;
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={photos}
        horizontal
        pagingEnabled
        initialScrollIndex={selectedIndex}
        keyExtractor={(item) => item.id}
        onMomentumScrollEnd={onScroll}
        showsHorizontalScrollIndicator={false}
        renderItem={({ item }) => (
          <View style={styles.page}>
            <PinchGestureHandler onHandlerStateChange={finishPinch}>
              <Animated.View style={styles.mediaGesture}>
                <Pressable onPress={onDoubleTap} style={styles.mediaGesture}>
                  {item.mime_type.startsWith('video/') && isPlayableVideo(item) ? (
                    <Video
                      testID={`media-video-${item.id}`}
                      source={{ uri: api.previewURL(item.id), headers: authHeaders }}
                      controls
                      resizeMode="contain"
                      style={styles.media}
                      onError={() => setUnsupportedPhotoId(item.id)}
                    />
                  ) : item.mime_type.startsWith('video/') ? (
                    <UnsupportedMedia photo={item} onDownload={openOriginal} />
                  ) : (
                    <AuthenticatedImage
                      testID={`media-preview-${item.id}`}
                      uri={api.previewURL(item.id)}
                      accessToken={authHeaders.Authorization?.replace(/^Bearer /, '')}
                      serverId={serverId}
                      userId={userId}
                      resizeMode="contain"
                      style={[styles.media, { transform: [{ scale }] }]}
                    />
                  )}
                  {unsupportedPhotoId === item.id ? <UnsupportedMedia photo={item} onDownload={openOriginal} /> : null}
                </Pressable>
              </Animated.View>
            </PinchGestureHandler>
          </View>
        )}
      />
      <View style={styles.toolbar}>
        <PrimaryButton label={t('viewer.details', '详情')} onPress={() => setDetailsVisible(true)} />
        <PrimaryButton label={t('viewer.download', '下载原文件')} onPress={openOriginal} />
        <PrimaryButton label={t('viewer.share', '分享')} onPress={() => { void shareSelected(); }} />
      </View>
      <Modal visible={detailsVisible} transparent animationType="slide" onRequestClose={() => setDetailsVisible(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setDetailsVisible(false)}>
          <View onStartShouldSetResponder={() => true}>
            <MediaDetailsSheet
              photo={selectedPhoto}
              onClose={() => setDetailsVisible(false)}
              onDownload={openOriginal}
              onShare={() => { void shareSelected(); }}
              onDelete={deleteSelected}
            />
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

function UnsupportedMedia({ photo, onDownload }: { photo: Photo; onDownload: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.unsupported}>
      <Text style={styles.unsupportedText}>{t('viewer.unsupportedCodec', '此视频格式无法在设备上播放')}</Text>
      <PrimaryButton label={t('viewer.download', '下载原文件')} onPress={onDownload} />
      <Text style={styles.filename}>{photo.filename}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#101418' },
  page: { width: '100%', flex: 1, alignItems: 'center', justifyContent: 'center' },
  mediaGesture: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  media: { width: '100%', height: '100%' },
  toolbar: { flexDirection: 'row', gap: spacing.sm, padding: spacing.md, backgroundColor: colors.surface },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  unsupported: { alignItems: 'center', gap: spacing.md, padding: spacing.lg },
  unsupportedText: { color: colors.surface, textAlign: 'center', fontSize: 16 },
  filename: { color: colors.surface },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  empty: { color: colors.muted },
});
