import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, spacing } from '../../components/theme';
import { PrimaryButton } from '../../components/ui';
import type { Photo } from '../../services/api/types';
import '../../i18n';

export type MediaDetailsSheetProps = {
  photo: Photo;
  onClose?: () => void;
  onShare?: () => void;
  onDownload?: () => void;
  onDelete?: () => void;
};

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function MediaDetailsSheet({
  photo,
  onClose,
  onShare,
  onDownload,
  onDelete,
}: MediaDetailsSheetProps) {
  const { t } = useTranslation();
  return (
    <View testID="media-details" style={styles.sheet}>
      <View style={styles.heading}>
        <Text style={styles.title}>{t('viewer.details', '媒体详情')}</Text>
        {onClose ? (
          <Pressable accessibilityRole="button" accessibilityLabel={t('common.close', '关闭')} onPress={onClose} style={styles.close}>
            <Text style={styles.closeText}>×</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.filename}>{photo.filename}</Text>
      <Text style={styles.value}>{photo.mime_type}</Text>
      <Text style={styles.value}>{formatBytes(photo.size)}</Text>
      {photo.width && photo.height ? <Text style={styles.value}>{photo.width} × {photo.height}</Text> : null}
      <Text style={styles.value}>{new Date(photo.captured_at).toLocaleString()}</Text>
      <View style={styles.actions}>
        {onDownload ? <PrimaryButton label={t('viewer.download', '下载原文件')} onPress={onDownload} /> : null}
        {onShare ? <PrimaryButton label={t('viewer.share', '分享')} onPress={onShare} /> : null}
        {onDelete ? <PrimaryButton label={t('viewer.delete', '永久删除')} onPress={onDelete} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    gap: spacing.sm,
    padding: spacing.lg,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.ink, fontSize: 20, fontWeight: '800' },
  close: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: colors.muted, fontSize: 30, lineHeight: 34 },
  filename: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  value: { color: colors.muted, fontSize: 14 },
  actions: { gap: spacing.sm, marginTop: spacing.xs },
});
