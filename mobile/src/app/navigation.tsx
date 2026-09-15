import React, { useMemo } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Screen } from '../components/ui';
import { colors } from '../components/theme';
import { ConnectionSettingsScreen } from '../features/auth/ConnectionSettingsScreen';
import { LoginScreen } from '../features/auth/LoginScreen';
import { createApiClient } from '../services/api/client';
import { credentialsStore } from '../services/credentials';
import { connectionStore, getEnabledLANCIDRs } from '../services/connection/store';
import type { ServerConfig } from '../services/connection/types';
import { useBoot } from './useBoot';
import '../i18n';

type RootStackParamList = {
  Loading: undefined;
  Connection: undefined;
  Login: undefined;
  Main: undefined;
  Viewer: undefined;
};

type MainTabParamList = {
  Gallery: undefined;
  Upload: undefined;
  Settings: undefined;
};

const RootStack = createNativeStackNavigator<RootStackParamList>();
const MainTabs = createBottomTabNavigator<MainTabParamList>();

function LoadingScreen() {
  const { t } = useTranslation();
  return <Screen><Text>{t('app.loading')}</Text></Screen>;
}

function PlaceholderScreen({ title }: { title: string }) {
  return <Screen><Text style={styles.placeholderTitle}>{title}</Text></Screen>;
}

function MainTabNavigator() {
  const { t } = useTranslation();
  return (
    <MainTabs.Navigator screenOptions={{ headerShown: false, tabBarActiveTintColor: colors.accent }}>
      <MainTabs.Screen name="Gallery">
        {() => <PlaceholderScreen title={t('tabs.gallery')} />}
      </MainTabs.Screen>
      <MainTabs.Screen name="Upload">
        {() => <PlaceholderScreen title={t('tabs.upload')} />}
      </MainTabs.Screen>
      <MainTabs.Screen name="Settings">
        {() => <PlaceholderScreen title={t('tabs.settings')} />}
      </MainTabs.Screen>
    </MainTabs.Navigator>
  );
}

function LoginRoute({ server, reload }: { server: ServerConfig; reload: () => void }) {
  const api = useMemo(
    () => createApiClient({ baseURL: server.baseURL, serverId: server.id, credentials: credentialsStore }),
    [server.baseURL, server.id],
  );
  return (
    <LoginScreen
      services={{
        server,
        lanCIDRs: getEnabledLANCIDRs(connectionStore.getState()),
        api,
        onInsecureConfirmed: (confirmedAt) =>
          connectionStore.getState().setServerInsecureConfirmation(server.id, confirmedAt),
        onAuthenticated: reload,
      }}
    />
  );
}

export function RootNavigator() {
  const { t } = useTranslation();
  const { state, reload } = useBoot();
  return (
    <NavigationContainer>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        {state.status === 'loading' ? <RootStack.Screen name="Loading" component={LoadingScreen} /> : null}
        {state.status === 'needs-server' ? (
          <RootStack.Screen name="Connection" component={ConnectionSettingsScreen} />
        ) : null}
        {state.status === 'needs-login' ? (
          <RootStack.Screen name="Login">
            {() => <LoginRoute server={state.server} reload={reload} />}
          </RootStack.Screen>
        ) : null}
        {state.status === 'authenticated' ? (
          <RootStack.Screen name="Main" component={MainTabNavigator} />
        ) : null}
        {state.status === 'authenticated' ? (
          <RootStack.Screen name="Viewer">
            {() => <PlaceholderScreen title={t('viewer.title')} />}
          </RootStack.Screen>
        ) : null}
      </RootStack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  placeholderTitle: { color: colors.ink, fontSize: 28, fontWeight: '800' },
});
