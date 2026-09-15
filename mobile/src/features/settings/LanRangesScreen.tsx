import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Field, Message, PrimaryButton, Screen } from '../../components/ui';
import { colors, spacing } from '../../components/theme';
import { DEFAULT_LAN_CIDRS, validateManualCIDR } from '../../services/connection/policy';
import type { ConnectionStore } from '../../services/connection/store';
import { getEnabledLANCIDRs } from '../../services/connection/store';
import '../../i18n';

export function useConnectionSnapshot(store: ConnectionStore) {
  const [state, setState] = useState(store.getState());
  useEffect(() => store.subscribe(() => setState(store.getState())), [store]);
  return state;
}

export function LanRangesScreen({ store, onDone }: { store: ConnectionStore; onDone?: () => void }) {
  const { t } = useTranslation();
  const settings = useConnectionSnapshot(store);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pendingGlobal, setPendingGlobal] = useState<string | null>(null);

  const add = () => {
    setError(null);
    const validation = validateManualCIDR(input);
    if (!validation.ok) {
      setPendingGlobal(null);
      setError(validation.reason === 'catch_all' ? t('settings.catchAll', '不能添加全网范围') : t('settings.invalidCIDR', '地址范围格式无效'));
      return;
    }
    if (validation.globallyRoutable && pendingGlobal !== input.trim()) {
      setPendingGlobal(input.trim());
      setError(t('settings.globalWarning', '这是公网地址范围，确认后才会允许使用。'));
      return;
    }
    const result = store.getState().addManualCIDR(input);
    if (!result.ok) {
      setError(t('settings.invalidCIDR', '地址范围格式无效'));
      return;
    }
    setPendingGlobal(null);
    setInput('');
  };

  const confirmGlobal = () => {
    if (!pendingGlobal) return;
    const result = store.getState().addManualCIDR(pendingGlobal);
    if (result.ok) {
      setPendingGlobal(null);
      setInput('');
      setError(null);
    }
  };

  return (
    <Screen>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{t('settings.lanTitle', '内网地址范围')}</Text>
        {onDone ? <Pressable accessibilityRole="button" accessibilityLabel={t('common.back', '返回')} onPress={onDone} style={styles.back}><Text style={styles.backText}>{t('common.back', '返回')}</Text></Pressable> : null}
      </View>
      <Text style={styles.subtitle}>{t('settings.lanSubtitle', '仅允许命中范围的 IP 使用未加密 HTTP。')}</Text>
      <Text style={styles.section}>{t('settings.builtIn', '内置范围')}</Text>
      {DEFAULT_LAN_CIDRS.map((cidr) => (
        <View key={cidr} style={styles.row}>
          <Text style={styles.range}>{cidr}</Text>
          <Switch
            testID={`builtin-cidr-${cidr}`}
            accessibilityLabel={cidr}
            disabled={false}
            value={settings.builtInCIDREnabled[cidr] !== false}
            onValueChange={(enabled) => store.getState().setBuiltInCIDREnabled(cidr, enabled)}
          />
        </View>
      ))}
      <Text style={styles.section}>{t('settings.manual', '手动范围')}</Text>
      {settings.manualCIDRs.map((entry) => (
        <View key={entry.cidr} style={styles.row}>
          <Text style={styles.range}>{entry.cidr}</Text>
          <Switch
            accessibilityLabel={entry.cidr}
            value={entry.enabled}
            onValueChange={(enabled) => store.getState().setManualCIDREnabled(entry.cidr, enabled)}
          />
          <Pressable accessibilityRole="button" accessibilityLabel={`${t('settings.remove', '删除')} ${entry.cidr}`} onPress={() => store.getState().removeManualCIDR(entry.cidr)} style={styles.remove}>
            <Text style={styles.removeText}>{t('settings.remove', '删除')}</Text>
          </Pressable>
        </View>
      ))}
      <Field label={t('settings.addCIDR', '新增内网地址范围')} value={input} onChangeText={setInput} autoCapitalize="none" autoCorrect={false} />
      <PrimaryButton label={t('settings.addRange', '添加地址范围')} onPress={add} disabled={!input.trim()} />
      {pendingGlobal ? <PrimaryButton label={t('settings.confirmGlobal', '确认添加公网范围')} onPress={confirmGlobal} /> : null}
      {error ? <Message>{error}</Message> : null}
      <Text style={styles.enabledSummary}>{t('settings.enabledCount', `${getEnabledLANCIDRs(settings).length} 个范围已启用`, { count: getEnabledLANCIDRs(settings).length })}</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.ink, fontSize: 28, fontWeight: '800' },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  back: { minHeight: 48, justifyContent: 'center', paddingHorizontal: spacing.sm },
  backText: { color: colors.accent, fontWeight: '700' },
  subtitle: { color: colors.muted, fontSize: 15, lineHeight: 22 },
  section: { color: colors.ink, fontSize: 17, fontWeight: '800', marginTop: spacing.sm },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  range: { flex: 1, color: colors.ink, fontSize: 15, fontFamily: 'monospace' },
  remove: { minHeight: 48, justifyContent: 'center', paddingHorizontal: spacing.xs },
  removeText: { color: colors.error, fontWeight: '700' },
  enabledSummary: { color: colors.muted, fontSize: 13 },
});
