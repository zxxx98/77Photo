import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
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
  onInsecureConfirmed?: (confirmedAt: string | null) => void | Promise<void>;
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
  const [httpConfirmed, setHttpConfirmed] = useState(Boolean(services.server.allowInsecureConfirmedAt));
  const decision = useMemo(
    () => evaluateServerURL(services.server.baseURL, services.lanCIDRs),
    [services.lanCIDRs, services.server.baseURL],
  );

  useEffect(() => {
    setHttpConfirmed(Boolean(services.server.allowInsecureConfirmedAt));
  }, [services.server.allowInsecureConfirmedAt, services.server.id]);

  const submit = async () => {
    setError(null);
    if (!decision.allowed) {
      setError(policyMessage(decision.reason, t));
      return;
    }
    if (decision.insecure && !httpConfirmed) {
      setError(t('auth.confirmLan', '请先确认仅在受控内网使用未加密 HTTP。'));
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
      {decision.allowed && decision.insecure ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel={t('auth.confirmLanControl', '确认在内网使用未加密 HTTP')}
          accessibilityState={{ checked: httpConfirmed }}
          onPress={() => {
            const next = !httpConfirmed;
            setHttpConfirmed(next);
            Promise.resolve(services.onInsecureConfirmed?.(next ? new Date().toISOString() : null)).catch(() => undefined);
          }}
          style={styles.confirmRow}
        >
          <Text style={styles.checkbox}>{httpConfirmed ? '☑' : '☐'}</Text>
          <Text style={styles.confirmText}>{t('auth.confirmLanControl', '确认在内网使用未加密 HTTP')}</Text>
        </Pressable>
      ) : null}
      {!decision.allowed ? <Message>{policyMessage(decision.reason, t)}</Message> : null}
      {error ? <Message>{error}</Message> : null}
      <Field label={t('auth.username')} autoCapitalize="none" autoCorrect={false} value={username} onChangeText={setUsername} />
      <Field label={t('auth.password')} secureTextEntry value={password} onChangeText={setPassword} />
      <PrimaryButton
        label={t('auth.login')}
        loading={loading}
        disabled={loading || !decision.allowed || (decision.insecure && !httpConfirmed)}
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
  confirmRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  checkbox: { color: colors.accent, fontSize: 24 },
  confirmText: { flex: 1, color: colors.ink, fontSize: 15 },
});
