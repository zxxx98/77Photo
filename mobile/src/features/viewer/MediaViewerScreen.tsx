import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  BackHandler,
  FlatList,
  Modal,
  Pressable,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { PinchGestureHandler, State, type PinchGestureHandlerStateChangeEvent } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import Video from 'react-native-video';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '../../components/theme';
import { PrimaryButton } from '../../components/ui';
import type { ApiClient } from '../../services/api/client';
import type { Folder, Photo, User } from '../../services/api/types';
import { AuthenticatedImage } from '../gallery/AuthenticatedImage';
import { MediaDetailsSheet } from './MediaDetailsSheet';
import '../../i18n';

export type MediaViewerScreenProps = {
  api: Pick<ApiClient, 'previewURL' | 'livePhotoURL' | 'originalURL' | 'downloadOriginal' | 'getAuthHeaders' | 'createShareLink' | 'deletePhoto'> & {
    getFolder?: (id: string) => Promise<Folder>;
  };
  photos: readonly Photo[];
  initialIndex?: number;
  serverId?: string;
  userId?: string;
  userRole?: User['role'];
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
  userRole = 'user',
  onClose,
  onDeleted,
}: MediaViewerScreenProps) {
  const { t } = useTranslation();
  const [selectedIndex, setSelectedIndex] = useState(Math.min(Math.max(initialIndex, 0), Math.max(photos.length - 1, 0)));
  const [authHeaders, setAuthHeaders] = useState<Record<string, string>>({});
  const [detailsVisible, setDetailsVisible] = useState(false);
  const [unsupportedPhotoId, setUnsupportedPhotoId] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<Folder | null>(null);
  const lastTap = useRef(0);
  const scale = useRef(new Animated.Value(1)).current;
  const pinchScale = useRef(1);
  const selectedPhoto = photos[selectedIndex];
  const isPhotoOwner = Boolean(selectedPhoto && userId && selectedPhoto.owner_id === userId);
  const canShare = userRole === 'admin' || isPhotoOwner;
  const selectedFolderId = selectedPhoto?.folder_id;
  const folderForSelection = selectedFolder?.id === selectedFolderId ? selectedFolder : null;
  const canDelete = canShare || folderForSelection?.owner_id === userId || folderForSelection?.inherited_permission === 'write';

  useEffect(() => {
    let cancelled = false;
    setSelectedFolder(null);
    if (!selectedFolderId || canShare || !api.getFolder) return () => { cancelled = true; };
    api.getFolder(selectedFolderId).then((folder) => {
      if (!cancelled) setSelectedFolder(folder);
    }).catch(() => {
      if (!cancelled) setSelectedFolder(null);
    });
    return () => { cancelled = true; };
  }, [api, canShare, selectedFolderId]);

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
            api.deletePhoto(selectedPhoto.id).then(() => {
              onDeleted?.(selectedPhoto.id);
              setDetailsVisible(false);
              onClose?.();
            }).catch(() => undefined);
          },
        },
      ],
    );
  };

  const openOriginal = (photo = selectedPhoto) => {
    if (photo) api.downloadOriginal(photo.id, photo.filename).catch(() => undefined);
  };

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const width = event.nativeEvent.layoutMeasurement.width;
    if (width > 0) setSelectedIndex(Math.round(event.nativeEvent.contentOffset.x / width));
  };

  if (!selectedPhoto) {
    return <View style={styles.center}><Text style={styles.empty}>{t('viewer.empty', '没有可查看的媒体')}</Text></View>;
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" />
      <View style={styles.topBar}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('common.back', '返回')} onPress={onClose} style={styles.iconButton}>
          <Text style={styles.topText}>‹</Text>
        </Pressable>
        <Text style={styles.count}>{selectedIndex + 1} / {photos.length}</Text>
        <View style={styles.iconButton} />
      </View>
      <FlatList
        style={styles.mediaList}
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
                  {item.is_live_photo ? (
                    <Video
                      testID={`media-video-${item.id}`}
                      source={{ uri: api.livePhotoURL(item.id), headers: authHeaders }}
                      poster={{
                        source: { uri: api.previewURL(item.id), headers: authHeaders },
                        resizeMode: 'contain',
                      }}
                      controls
                      resizeMode="contain"
                      style={styles.media}
                      onError={() => setUnsupportedPhotoId(item.id)}
                    />
                  ) : item.mime_type.startsWith('video/') && isPlayableVideo(item) ? (
                    <Video
                      testID={`media-video-${item.id}`}
                      source={{ uri: api.previewURL(item.id), headers: authHeaders }}
                      controls
                      resizeMode="contain"
                      style={styles.media}
                      onError={() => setUnsupportedPhotoId(item.id)}
                    />
                  ) : item.mime_type.startsWith('video/') ? (
                    <UnsupportedMedia photo={item} onDownload={() => openOriginal(item)} />
                  ) : (
                    <RetryingPreviewImage
                      testID={`media-preview-${item.id}`}
                      uri={api.previewURL(item.id)}
                      accessToken={authHeaders.Authorization?.replace(/^Bearer /, '')}
                      serverId={serverId}
                      userId={userId}
                      resizeMode="contain"
                      style={[styles.media, { transform: [{ scale }] }]}
                      errorLabel={t('viewer.previewError', '预览加载失败')}
                      downloadLabel={t('viewer.download', '下载原文件')}
                      onDownload={() => openOriginal(item)}
                    />
                  )}
                  {unsupportedPhotoId === item.id ? <UnsupportedMedia photo={item} onDownload={openOriginal} /> : null}
                  {item.is_live_photo ? <Text style={styles.liveBadge}>LIVE</Text> : null}
                </Pressable>
              </Animated.View>
            </PinchGestureHandler>
          </View>
        )}
      />
      <View style={styles.toolbar}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('viewer.details', '详情')} onPress={() => setDetailsVisible(true)} style={styles.toolbarAction}><Text style={styles.toolbarText}>{t('viewer.details', '详情')}</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t('viewer.download', '下载原文件')} onPress={() => openOriginal()} style={styles.toolbarAction}><Text style={styles.toolbarText}>{t('viewer.download', '下载原文件')}</Text></Pressable>
        {canShare ? <Pressable accessibilityRole="button" accessibilityLabel={t('viewer.share', '分享')} onPress={() => { shareSelected().catch(() => undefined); }} style={styles.toolbarAction}><Text style={styles.toolbarText}>{t('viewer.share', '分享')}</Text></Pressable> : null}
      </View>
      <Modal visible={detailsVisible} transparent animationType="slide" onRequestClose={() => setDetailsVisible(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setDetailsVisible(false)}>
          <View onStartShouldSetResponder={() => true}>
            <MediaDetailsSheet
              photo={selectedPhoto}
              onClose={() => setDetailsVisible(false)}
              onDownload={openOriginal}
              onShare={canShare ? () => { shareSelected().catch(() => undefined); } : undefined}
              onDelete={canDelete ? deleteSelected : undefined}
            />
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function RetryingPreviewImage({
  uri,
  errorLabel,
  downloadLabel,
  onDownload,
  ...imageProps
}: React.ComponentProps<typeof AuthenticatedImage> & {
  errorLabel: string;
  downloadLabel: string;
  onDownload: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setAttempt(0);
    setLoading(true);
    setFailed(false);
    return () => {
      if (retryTimer.current !== null) clearTimeout(retryTimer.current);
    };
  }, [uri]);

  const handleError = () => {
    if (attempt >= PREVIEW_RETRY_LIMIT) {
      setLoading(false);
      setFailed(true);
      return;
    }
    if (retryTimer.current !== null) return;
    setLoading(true);
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null;
      setAttempt((current) => current + 1);
    }, PREVIEW_RETRY_DELAY_MS);
  };

  const requestURI = attempt === 0
    ? uri
    : `${uri}${uri.includes('?') ? '&' : '?'}preview_retry=${attempt}`;

  return (
    <View style={styles.previewContainer}>
      <AuthenticatedImage
        {...imageProps}
        key={`${uri}-${attempt}`}
        uri={requestURI}
        onLoad={() => {
          if (retryTimer.current !== null) {
            clearTimeout(retryTimer.current);
            retryTimer.current = null;
          }
          setLoading(false);
          setFailed(false);
        }}
        onError={handleError}
      />
      {loading && !failed ? (
        <View pointerEvents="none" style={styles.previewStatus}>
          <ActivityIndicator color={colors.surface} />
        </View>
      ) : null}
      {failed ? (
        <View style={styles.previewFailure}>
          <Text style={styles.unsupportedText}>{errorLabel}</Text>
          <PrimaryButton label={downloadLabel} onPress={onDownload} />
        </View>
      ) : null}
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
  container: { flex: 1, backgroundColor: '#000000' },
  mediaList: { flex: 1 },
  topBar: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  iconButton: { width: 52, height: 48, alignItems: 'center', justifyContent: 'center' },
  topText: { color: colors.surface, fontSize: 30 },
  count: { color: colors.surface, fontSize: 14, fontWeight: '600' },
  liveBadge: { position: 'absolute', top: spacing.sm, left: spacing.md, color: colors.surface, backgroundColor: 'rgba(0,0,0,0.65)', paddingHorizontal: spacing.xs, paddingVertical: 4, borderRadius: 4, fontSize: 11, fontWeight: '700' },
  page: { width: '100%', flex: 1, alignItems: 'center', justifyContent: 'center' },
  mediaGesture: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  media: { width: '100%', height: '100%' },
  previewContainer: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  previewStatus: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  previewFailure: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.lg, backgroundColor: '#000000' },
  toolbar: { flexDirection: 'row', paddingHorizontal: spacing.sm, backgroundColor: '#000000', borderTopWidth: 1, borderTopColor: '#262626' },
  toolbarAction: { flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xs },
  toolbarText: { color: colors.surface, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  unsupported: { alignItems: 'center', gap: spacing.md, padding: spacing.lg },
  unsupportedText: { color: colors.surface, textAlign: 'center', fontSize: 16 },
  filename: { color: colors.surface },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  empty: { color: colors.muted },
});

const PREVIEW_RETRY_LIMIT = 5;
const PREVIEW_RETRY_DELAY_MS = 1_000;
