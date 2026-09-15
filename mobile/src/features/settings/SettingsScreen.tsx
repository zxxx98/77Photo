import React from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, spacing } from '../../components/theme';
import { Message, PrimaryButton, Screen } from '../../components/ui';
import type { ApiClient } from '../../services/api/client';
import type { User } from '../../services/api/types';
import type { ServerConfig } from '../../services/connection/types';
import type { ConnectionStore } from '../../services/connection/store';
import type { AppLanguage } from '../../services/connection/types';
import i18n, { resolveLanguage } from '../../i18n';
import { useConnectionSnapshot } from './LanRangesScreen';
import { RescanPanel } from './RescanPanel';
import '../../i18n';

type QueryCache = {
  removeQueries: (filters: { predicate: (query: { queryKey: readonly unknown[] }) => boolean }) => unknown;
};

export type SettingsScreenProps = {
  store: ConnectionStore;
  server: ServerConfig;
  user: User;
  api?: Pick<ApiClient, 'startRescan' | 'getRescan'>;
  queryClient?: QueryCache;
  onOpenLanRanges?: () => void;
  onLogout?: () => void | Promise<void>;
  onSwitchServer?: (serverId: string) => void;
};

function ValueSelector({ value, onChange, label }: { value: number; onChange: (value: number) => void; label: string }) {
  return (
    <View
      {...({ accessibilityLabel: label, selectedValue: value, onValueChange: onChange } as Record<string, unknown>)}
      style={styles.selector}
    >
      {[1, 2, 3, 4].map((candidate) => (
        <Pressable key={candidate} onPress={() => onChange(candidate)} style={[styles.selectorOption, candidate === value && styles.selectorOptionActive]}>
          <Text style={styles.selectorText}>{candidate}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function LanguageSelector({ value, onChange }: { value: AppLanguage; onChange: (value: AppLanguage) => void }) {
  const { t } = useTranslation();
  const choices: Array<{ value: AppLanguage; label: string }> = [
    { value: 'system', label: t('settings.languageSystem', '跟随系统') },
    { value: 'zh', label: t('settings.languageChinese', '简体中文') },
    { value: 'en', label: 'English' },
  ];
  return (
    <View style={styles.languageSelector}>
      {choices.map((choice) => (
        <Pressable
          key={choice.value}
          accessibilityRole="radio"
          accessibilityLabel={choice.label}
          accessibilityState={{ selected: choice.value === value }}
          onPress={() => onChange(choice.value)}
          style={[styles.languageOption, choice.value === value && styles.selectorOptionActive]}
        >
          <Text style={styles.selectorText}>{choice.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function SettingsScreen({
  store,
  server,
  user,
  api,
  queryClient,
  onOpenLanRanges,
  onLogout,
  onSwitchServer,
}: SettingsScreenProps) {
  const { t } = useTranslation();
  const settings = useConnectionSnapshot(store);
  const switchTargets = settings.servers.filter((candidate) => candidate.id !== server.id);

  const clearCache = () => {
    queryClient?.removeQueries({
      predicate: ({ queryKey }) =>
        (queryKey[0] === 'photos' || queryKey[0] === 'folders') && queryKey[1] === server.id && queryKey[2] === user.id,
    });
  };

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>{t('tabs.settings', '设置')}</Text>
        <Text style={styles.title}>{t('settings.title', '应用设置')}</Text>
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('settings.account', '账号与服务器')}</Text>
        <Text style={styles.value}>{user.username}</Text>
        <Text style={styles.meta}>{server.displayName} · {server.baseURL}</Text>
        {onSwitchServer && switchTargets.length > 0 ? (
          <View style={styles.switchTargets}>
            <Text style={styles.label}>{t('settings.switchServer', '切换服务器')}</Text>
            {switchTargets.map((candidate) => (
              <Pressable
                key={candidate.id}
                accessibilityRole="button"
                accessibilityLabel={`${t('settings.switchTo', '切换到')} ${candidate.displayName}`}
                onPress={() => onSwitchServer(candidate.id)}
                style={styles.actionRow}
              >
                <Text style={styles.actionText}>{candidate.displayName}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {onLogout ? <PrimaryButton label={t('settings.logout', '退出当前设备')} onPress={() => { Promise.resolve(onLogout()).catch(() => undefined); }} /> : null}
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('settings.uploadStorage', '上传与存储')}</Text>
        <Text style={styles.label}>{t('settings.concurrency', '同时上传数')}</Text>
        <ValueSelector
          label={t('settings.concurrency', '同时上传数')}
          value={settings.uploadConcurrency}
          onChange={(value) => store.getState().setUploadConcurrency(value as 1 | 2 | 3 | 4)}
        />
        <View style={styles.switchRow}>
          <Text style={styles.label}>{t('settings.cellular', '允许移动网络上传')}</Text>
          <Switch
            accessibilityLabel={t('settings.cellular', '允许移动网络上传')}
            value={settings.cellularUploadEnabled}
            onValueChange={(value) => store.getState().setCellularUploadEnabled(value)}
          />
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={t('settings.clearCache', '清理缩略图缓存')} onPress={clearCache} style={styles.actionRow}>
          <Text style={styles.actionText}>{t('settings.clearCache', '清理缩略图缓存')}</Text>
        </Pressable>
        <Message warning>{t('settings.cacheHint', '清理缓存不会删除原始照片或上传队列。')}</Message>
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('settings.network', '网络')}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t('settings.lanRanges', '编辑内网地址范围')} onPress={onOpenLanRanges} style={styles.actionRow}>
          <Text style={styles.actionText}>{t('settings.lanRanges', '编辑内网地址范围')}</Text>
        </Pressable>
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('settings.languageSection', '语言')}</Text>
        <LanguageSelector
          value={settings.language}
          onChange={(language) => {
            store.getState().setLanguage(language);
            i18n.changeLanguage(resolveLanguage(language)).catch(() => undefined);
          }}
        />
      </View>
      {user.role === 'admin' && api ? <RescanPanel api={api} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing.xs },
  eyebrow: { color: colors.accent, fontSize: 14, fontWeight: '700', textTransform: 'uppercase' },
  title: { color: colors.ink, fontSize: 30, fontWeight: '800' },
  section: { gap: spacing.sm, padding: spacing.md, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  sectionTitle: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  value: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  meta: { color: colors.muted, fontSize: 13 },
  label: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  selector: { flexDirection: 'row', gap: spacing.xs },
  selectorOption: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  selectorOptionActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  selectorText: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  languageSelector: { gap: spacing.xs },
  languageOption: { minHeight: 48, justifyContent: 'center', paddingHorizontal: spacing.sm, borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  switchRow: { minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  actionRow: { minHeight: 48, justifyContent: 'center' },
  actionText: { color: colors.accent, fontWeight: '700' },
  switchTargets: { gap: spacing.xs },
});
