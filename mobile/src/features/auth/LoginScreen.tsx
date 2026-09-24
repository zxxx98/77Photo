import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Message, Field, PrimaryButton, Screen } from '../../components/ui';
import { colors, spacing } from '../../components/theme';
import { evaluateServerURL } from '../../services/connection/policy';
import type { ServerConfig } from '../../services/connection/types';
import { ApiError } from '../../services/api/client';
import type { MobileSessionResponse } from '../../services/api/types';
import '../../i18n';

export type LoginSubmitInput = {
  baseURL: string;
  username: string;
  password: string;
  allowInsecureConfirmedAt: string | null;
};

export type LoginScreenServices = {
  server?: ServerConfig;
  lanCIDRs: readonly string[];
  login: (input: LoginSubmitInput) => Promise<MobileSessionResponse>;
  onAuthenticated?: (session: MobileSessionResponse) => void | Promise<void>;
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
    if (error.code === 'INVALID_RESPONSE') {
      return t('auth.invalidResponse');
    }
    return error.message;
  }
  if (error instanceof Error && error.message === 'SERVER_MOBILE_API_UNSUPPORTED') {
    return t('auth.unsupportedMobile');
  }
  if (error instanceof Error && (error as Error & { code?: string }).code === 'INVALID_CREDENTIALS') {
    return t('auth.invalidCredentials');
  }
  if (
    error instanceof Error &&
    ((error as Error & { code?: string }).code === 'CREDENTIALS_ERROR' ||
      error.message.includes('NativeCredentials'))
  ) {
    return t('auth.credentialStoreFailed');
  }
  if (
    error instanceof TypeError ||
    (error instanceof Error &&
      (error.message.includes('Network request failed') ||
        error.message.startsWith('server_') ||
        error.message.startsWith('redirect_')))
  ) {
    return t('auth.healthFailed');
  }
  return t('auth.loginFailed');
}

export function LoginScreen({ services }: { services: LoginScreenServices }) {
  const { t } = useTranslation();
  const [baseURL, setBaseURL] = useState(services.server?.baseURL ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [httpConfirmed, setHttpConfirmed] = useState(Boolean(services.server?.allowInsecureConfirmedAt));
  const decision = useMemo(
    () => evaluateServerURL(baseURL, services.lanCIDRs),
    [baseURL, services.lanCIDRs],
  );

  useEffect(() => {
    setBaseURL(services.server?.baseURL ?? '');
    setHttpConfirmed(Boolean(services.server?.allowInsecureConfirmedAt));
  }, [services.server?.allowInsecureConfirmedAt, services.server?.baseURL, services.server?.id]);

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
      const session = await services.login({
        baseURL: decision.normalizedURL,
        username: username.trim(),
        password,
        allowInsecureConfirmedAt: decision.insecure ? new Date().toISOString() : null,
      });
      await services.onAuthenticated?.(session);
    } catch (caught) {
      setError(loginErrorMessage(caught, t));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen contentStyle={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>77Photo</Text>
        <Text style={styles.subtitle}>{t('auth.tagline', '记录生活的每一刻')}</Text>
      </View>
      {error ? <Message>{error}</Message> : null}
      <Field
        label={t('connection.url')}
        hint={t('auth.serverExample', '例如 https://photos.example')}
        error={baseURL.trim() && !decision.allowed ? policyMessage(decision.reason, t) : undefined}
        editable={!loading}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="http://192.168.1.10:8080"
        value={baseURL}
        onChangeText={(value) => {
          setBaseURL(value);
          if (value.trim() !== services.server?.baseURL) {
            setHttpConfirmed(false);
          }
        }}
      />
      {decision.allowed && decision.insecure ? <Message warning>{t('auth.lanWarning')}</Message> : null}
      {decision.allowed && decision.insecure ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel={t('auth.confirmLanControl', '确认在内网使用未加密 HTTP')}
          accessibilityState={{ checked: httpConfirmed }}
          onPress={() => setHttpConfirmed((value) => !value)}
          style={styles.confirmRow}
        >
          <Text style={styles.checkbox}>{httpConfirmed ? '☑' : '☐'}</Text>
          <Text style={styles.confirmText}>{t('auth.confirmLanControl', '确认在内网使用未加密 HTTP')}</Text>
        </Pressable>
      ) : null}
      <Field label={t('auth.username')} editable={!loading} autoCapitalize="none" autoCorrect={false} value={username} onChangeText={setUsername} />
      <Field
        label={t('auth.password')}
        editable={!loading}
        secureTextEntry={!passwordVisible}
        value={password}
        onChangeText={setPassword}
        trailing={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={passwordVisible ? t('auth.hidePassword', '隐藏密码') : t('auth.showPassword', '显示密码')}
            disabled={loading}
            onPress={() => setPasswordVisible((visible) => !visible)}
            style={styles.visibility}
          >
            <Text style={styles.visibilityText}>{passwordVisible ? t('auth.hide', '隐藏') : t('auth.show', '显示')}</Text>
          </Pressable>
        }
      />
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
  screen: { justifyContent: 'center', paddingBottom: 72 },
  header: { alignItems: 'center', gap: spacing.xs, marginBottom: spacing.xl },
  title: { color: colors.ink, fontSize: 36, fontWeight: '800' },
  subtitle: { color: colors.muted, fontSize: 15, lineHeight: 23 },
  visibility: { minWidth: 48, minHeight: 48, justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.xs },
  visibilityText: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  confirmRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  checkbox: { color: colors.accent, fontSize: 24 },
  confirmText: { flex: 1, color: colors.ink, fontSize: 15 },
});
