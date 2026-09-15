import React, { useCallback, useEffect, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, spacing } from '../../components/theme';
import { Message, PrimaryButton } from '../../components/ui';
import { ApiError, type ApiClient } from '../../services/api/client';
import type { RescanJob } from '../../services/api/types';
import '../../i18n';

export type RescanPanelProps = { api: Pick<ApiClient, 'startRescan' | 'getRescan'> };

export function RescanPanel({ api }: RescanPanelProps) {
  const { t } = useTranslation();
  const [job, setJob] = useState<RescanJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!job) return;
    try {
      setJob(await api.getRescan(job.id));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('settings.rescanRefreshError', '扫描状态暂时不可用'));
    }
  }, [api, job, t]);

  useEffect(() => {
    if (!job || (job.status !== 'queued' && job.status !== 'running')) return undefined;
    let inFlight = false;
    const poll = () => {
      if (AppState.currentState !== 'active' || inFlight) return;
      inFlight = true;
      api.getRescan(job.id)
        .then(setJob)
        .catch((caught) => setError(caught instanceof Error ? caught.message : t('settings.rescanRefreshError', '扫描状态暂时不可用')))
        .finally(() => { inFlight = false; });
    };
    const timer = setInterval(poll, 1_500);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') poll();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [api, job, t]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setJob(await api.startRescan());
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'RESCAN_IN_PROGRESS') {
        const existingJobId = caught.details?.job_id;
        if (typeof existingJobId === 'string' && existingJobId.trim()) {
          try {
            setJob(await api.getRescan(existingJobId));
            setError(null);
          } catch (refreshError) {
            setError(refreshError instanceof Error ? refreshError.message : t('settings.rescanRefreshError', '扫描状态暂时不可用'));
          }
        } else {
          setError(t('settings.rescanInProgress', '已有扫描正在进行，请稍后刷新状态。'));
        }
      } else {
        setError(caught instanceof Error ? caught.message : t('settings.rescanStartError', '扫描无法开始'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>{t('settings.rescanTitle', '服务器图库扫描')}</Text>
      <Text style={styles.subtitle}>{t('settings.rescanSubtitle', '扫描服务器文件夹并更新图库索引。')}</Text>
      <PrimaryButton label={t('settings.startRescan', '开始扫描')} loading={busy} disabled={busy} onPress={() => { start().catch(() => undefined); }} />
      {job ? <Text style={styles.status}>{t('settings.rescanStatus', `扫描状态：${job.status}`, { status: job.status })}</Text> : null}
      {job ? <Text style={styles.counts}>{job.counts.scanned} {t('settings.scanned', '已扫描')} · {job.counts.added} {t('settings.added', '新增')} · {job.counts.failed} {t('settings.failed', '失败')}</Text> : null}
      {error ? <Message>{error}</Message> : null}
      {error && !job ? <PrimaryButton label={t('settings.refreshRescan', '刷新扫描状态')} onPress={() => { start().catch(() => undefined); }} /> : null}
      {job && (job.status === 'queued' || job.status === 'running') ? <PrimaryButton label={t('settings.refreshRescan', '刷新扫描状态')} onPress={() => { refresh().catch(() => undefined); }} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: spacing.sm, padding: spacing.md, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  title: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  subtitle: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  status: { color: colors.ink, fontWeight: '700' },
  counts: { color: colors.muted, fontSize: 13 },
});
