import React, { useMemo, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Message, Field, PrimaryButton, Screen } from '../../components/ui';
import { colors, spacing } from '../../components/theme';
import { evaluateServerURL } from '../../services/connection/policy';
import type { ServerConfig } from '../../services/connection/types';
import { ApiError, type ApiClient } from '../../services/api/client';
import type { MobileSessionResponse } from '../../services/api/types';
import '../../i18n';

export type LoginScreenServices = {
  server: ServerConfig;
  lanCIDRs: readonly string[];
  api: Pick<ApiClient, 'healthz' | 'login'>;
  onAuthenticated?: (session: MobileSessionResponse) => void | Promise<void>;
  onInsecureConfirmed?: (confirmedAt: string) => void | Promise<void>;
};

function policyMessage(reason: string, t: (key: string) => string): string {
  switch (reason) {
    case 'http_outside_lan':
      return t('auth.blockedHttp');
    case 'http_hostname':
      return t('auth.httpHostname');
    case 'unsupported_scheme':
      return t('auth.unsupportedScheme');
    default:
      return t('auth.invalidURL');
  }
}

function loginErrorMessage(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiError) {
    if (error.status === 404 || error.code === 'NOT_FOUND' || error.code === 'SERVER_MOBILE_API_UNSUPPORTED') {
      return t('auth.unsupportedMobile');
    }
    if (error.code === 'INVALID_CREDENTIALS') {
      return t('auth.invalidCredentials');
    }
    if (error.code === 'SERVER_MOBILE_API_UNSUPPORTED') {
      return t('auth.unsupportedMobile');
    }
    return error.message;
  }
  if (error instanceof Error && error.message === 'SERVER_MOBILE_API_UNSUPPORTED') {
    return t('auth.unsupportedMobile');
  }
  if (error instanceof Error && (error as Error & { code?: string }).code === 'INVALID_CREDENTIALS') {
    return t('auth.invalidCredentials');
  }
  return t('auth.healthFailed');
}

export function LoginScreen({ services }: { services: LoginScreenServices }) {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decision = useMemo(
    () => evaluateServerURL(services.server.baseURL, services.lanCIDRs),
    [services.lanCIDRs, services.server.baseURL],
  );

  const submit = async () => {
    setError(null);
    if (!decision.allowed) {
      setError(policyMessage(decision.reason, t));
      return;
    }
    if (!username.trim() || !password) {
      setError(t('auth.invalidCredentials'));
      return;
    }
    setLoading(true);
    try {
      await services.api.healthz();
      const session = await services.api.login({
        username: username.trim(),
        password,
        deviceName: 'Android device',
        platform: 'android',
        appVersion: '1.0.0',
      });
      if (decision.insecure) {
        await services.onInsecureConfirmed?.(new Date().toISOString());
      }
      await services.onAuthenticated?.(session);
    } catch (caught) {
      setError(loginErrorMessage(caught, t));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>{services.server.displayName}</Text>
        <Text style={styles.title}>{t('auth.title')}</Text>
        <Text style={styles.subtitle}>{t('auth.subtitle')}</Text>
      </View>
      {decision.allowed && decision.insecure ? <Message warning>{t('auth.lanWarning')}</Message> : null}
      {!decision.allowed ? <Message>{policyMessage(decision.reason, t)}</Message> : null}
      {error ? <Message>{error}</Message> : null}
      <Field label={t('auth.username')} autoCapitalize="none" autoCorrect={false} value={username} onChangeText={setUsername} />
      <Field label={t('auth.password')} secureTextEntry value={password} onChangeText={setPassword} />
      <PrimaryButton
        label={t('auth.login')}
        loading={loading}
        disabled={loading || !decision.allowed}
        onPress={submit}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing.xs, marginBottom: spacing.sm },
  eyebrow: { color: colors.accent, fontSize: 14, fontWeight: '700', textTransform: 'uppercase' },
  title: { color: colors.ink, fontSize: 30, fontWeight: '800' },
  subtitle: { color: colors.muted, fontSize: 16, lineHeight: 23 },
});
