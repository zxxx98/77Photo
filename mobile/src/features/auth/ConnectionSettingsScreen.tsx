import React, { useState } from 'react';
import { Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Field, PrimaryButton, Screen } from '../../components/ui';
import { colors, spacing } from '../../components/theme';
import { connectionStore, getEnabledLANCIDRs } from '../../services/connection/store';
import { evaluateServerURL } from '../../services/connection/policy';
import '../../i18n';

export function ConnectionSettingsScreen() {
  const { t } = useTranslation();
  const [baseURL, setBaseURL] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = () => {
    setError(null);
    setSaved(false);
    const decision = evaluateServerURL(baseURL, getEnabledLANCIDRs(connectionStore.getState()));
    if (!decision.allowed || !decision.normalizedURL) {
      setError(decision.allowed ? t('connection.invalid') : t('connection.invalid'));
      return;
    }
    const id = connectionStore.getState().addServer({
      baseURL: decision.normalizedURL,
      displayName: displayName.trim() || decision.normalizedURL,
    });
    connectionStore.getState().selectServer(id);
    setSaved(true);
  };

  return (
    <Screen>
      <Text style={styles.title}>{t('connection.title')}</Text>
      <Text style={styles.subtitle}>{t('connection.subtitle')}</Text>
      {saved ? <Text style={styles.saved}>{t('connection.added')}</Text> : null}
      <Field
        label={t('connection.url')}
        error={error ?? undefined}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="https://photos.example"
        value={baseURL}
        onChangeText={(value) => { setBaseURL(value); setError(null); setSaved(false); }}
      />
      <Field label={t('connection.name')} value={displayName} onChangeText={setDisplayName} />
      <PrimaryButton label={t('connection.add')} onPress={save} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.ink, fontSize: 23, fontWeight: '700' },
  subtitle: { color: colors.muted, fontSize: 16, lineHeight: 23, marginBottom: spacing.md },
  saved: { color: colors.accent, fontWeight: '600' },
});
