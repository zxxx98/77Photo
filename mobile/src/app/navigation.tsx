import React, { useCallback, useMemo, useState } from 'react';
import { NavigationContainer, useIsFocused, useNavigation } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator, type NativeStackNavigationProp, type NativeStackScreenProps } from '@react-navigation/native-stack';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Screen } from '../components/ui';
import { colors, spacing } from '../components/theme';
import { TabBarIcon } from './TabBarIcon';
import { LoginScreen, type LoginSubmitInput } from '../features/auth/LoginScreen';
import { FolderBrowserScreen } from '../features/folders/FolderBrowserScreen';
import { GalleryScreen } from '../features/gallery/GalleryScreen';
import { MediaViewerScreen } from '../features/viewer/MediaViewerScreen';
import { UploadScreen } from '../features/upload/UploadScreen';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { LanRangesScreen } from '../features/settings/LanRangesScreen';
import { switchServerWithQueueDecision } from '../features/settings/serverSwitch';
import { uploadQueue } from '../features/upload/uploadService';
import { createApiClient } from '../services/api/client';
import type { Photo, User } from '../services/api/types';
import { credentialsStore } from '../services/credentials';
import { connectionStore, generateServerID, getEnabledLANCIDRs, useEnabledLANCIDRs } from '../services/connection/store';
import type { ServerConfig } from '../services/connection/types';
import { useBoot } from './useBoot';
import '../i18n';

type RootStackParamList = {
  Loading: undefined;
  Login: undefined;
  Main: undefined;
  Viewer: { photos: readonly Photo[]; initialIndex?: number };
};

type MainTabParamList = {
  Gallery: undefined;
  Upload: undefined;
  Folders: undefined;
  Settings: undefined;
};

const RootStack = createNativeStackNavigator<RootStackParamList>();
const MainTabs = createBottomTabNavigator<MainTabParamList>();

const galleryTabIcon = ({ color }: { color: string }) => <TabBarIcon name="gallery" color={color} />;
const uploadTabIcon = ({ color }: { color: string }) => <TabBarIcon name="upload" color={color} />;
const foldersTabIcon = ({ color }: { color: string }) => <TabBarIcon name="folders" color={color} />;
const settingsTabIcon = ({ color }: { color: string }) => <TabBarIcon name="settings" color={color} />;

function LoadingScreen() {
  const { t } = useTranslation();
  return <Screen><Text>{t('app.loading')}</Text></Screen>;
}

type AuthenticatedRouteProps = {
  server: ServerConfig;
  user: User;
  onSessionChanged?: () => void;
};

function AuthenticatedApi({ server, user }: AuthenticatedRouteProps) {
  const queryClient = useQueryClient();
  return useMemo(
    () => createApiClient({
      baseURL: server.baseURL,
      serverId: server.id,
      userId: user.id,
      lanCIDRs: () => getEnabledLANCIDRs(connectionStore.getState()),
      credentials: credentialsStore,
      queryClient,
    }),
    [queryClient, server.baseURL, server.id, user.id],
  );
}

function GalleryTab({ server, user }: AuthenticatedRouteProps) {
  const api = AuthenticatedApi({ server, user });
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  return (
    <SafeAreaView style={styles.galleryRoot} edges={['top', 'left', 'right']}>
      <Text style={styles.galleryTitle}>77Photo</Text>
      <GalleryScreen
        api={api}
        serverId={server.id}
        userId={user.id}
        onPhotoPress={(photo, photos) => navigation.navigate('Viewer', {
          photos,
          initialIndex: Math.max(0, photos.findIndex((item) => item.id === photo.id)),
        })}
      />
    </SafeAreaView>
  );
}

function FoldersTab({ server, user }: AuthenticatedRouteProps) {
  const api = AuthenticatedApi({ server, user });
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  return (
    <FolderBrowserScreen
      api={api}
      serverId={server.id}
      userId={user.id}
      onPhotoPress={(photo, photos) => navigation.navigate('Viewer', {
        photos,
        initialIndex: Math.max(0, photos.findIndex((item) => item.id === photo.id)),
      })}
    />
  );
}

function MainTabNavigator({ server, user, onSessionChanged }: AuthenticatedRouteProps) {
  const { t } = useTranslation();
  return (
    <MainTabs.Navigator screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: colors.accent,
      tabBarInactiveTintColor: colors.muted,
      tabBarStyle: styles.tabBar,
      tabBarLabelStyle: styles.tabLabel,
    }}>
      <MainTabs.Screen name="Gallery" options={{
        title: t('tabs.gallery', '图库'),
        tabBarIcon: galleryTabIcon,
      }}>
        {() => <GalleryTab server={server} user={user} />}
      </MainTabs.Screen>
      <MainTabs.Screen name="Upload" options={{
        title: t('tabs.upload', '上传'),
        tabBarIcon: uploadTabIcon,
      }}>
        {() => <UploadTab server={server} user={user} />}
      </MainTabs.Screen>
      <MainTabs.Screen name="Folders" options={{
        title: t('folders.title', '文件夹'),
        tabBarIcon: foldersTabIcon,
      }}>
        {() => <FoldersTab server={server} user={user} />}
      </MainTabs.Screen>
      <MainTabs.Screen name="Settings" options={{
        title: t('tabs.settings', '设置'),
        tabBarIcon: settingsTabIcon,
      }}>
        {() => <SettingsTab server={server} user={user} onSessionChanged={onSessionChanged} />}
      </MainTabs.Screen>
    </MainTabs.Navigator>
  );
}

function SettingsTab({ server, user, onSessionChanged }: AuthenticatedRouteProps) {
  const { t } = useTranslation();
  const api = AuthenticatedApi({ server, user });
  const queryClient = useQueryClient();
  const [lanRangesOpen, setLanRangesOpen] = useState(false);
  if (lanRangesOpen) {
    return <LanRangesScreen store={connectionStore} onDone={() => setLanRangesOpen(false)} />;
  }
  return (
    <SettingsScreen
      store={connectionStore}
      server={server}
      user={user}
      api={api}
      queryClient={queryClient}
      onOpenLanRanges={() => setLanRangesOpen(true)}
      onSwitchServer={(targetServerId) => {
        switchServerWithQueueDecision({
          fromServerId: server.id,
          targetServerId,
          queue: uploadQueue,
          store: connectionStore,
          labels: {
            title: t('settings.switchTitle', '切换服务器'),
            message: t('settings.switchQueueMessage', '当前服务器还有未完成上传，如何处理？'),
            cancel: t('settings.switchStay', '留在当前服务器'),
            keep: t('settings.switchKeepQueue', '保留队列'),
            discard: t('settings.switchDiscardQueue', '取消旧队列'),
          },
          onStay: async () => {
            const credentials = await credentialsStore.get(server.id);
            if (!credentials?.deviceId) return;
            await uploadQueue.resume(server.id);
            await uploadQueue.start?.(
              server.id,
              server.baseURL,
              credentials.deviceId,
              connectionStore.getState().uploadConcurrency,
              connectionStore.getState().cellularUploadEnabled,
              getEnabledLANCIDRs(connectionStore.getState()),
            );
          },
          onSelected: onSessionChanged,
        }).catch(() => undefined);
      }}
      onLogout={async () => {
        await api.logout();
        onSessionChanged?.();
      }}
    />
  );
}

function UploadTab({ server, user }: AuthenticatedRouteProps) {
  const api = AuthenticatedApi({ server, user });
  const isFocused = useIsFocused();
  const concurrency = connectionStore((state) => state.uploadConcurrency);
  const cellularUploadEnabled = connectionStore((state) => state.cellularUploadEnabled);
  const lanCIDRs = useEnabledLANCIDRs();
  return (
    <UploadScreen
      api={api}
      server={server}
      user={user}
      concurrency={concurrency}
      cellularUploadEnabled={cellularUploadEnabled}
      lanCIDRs={lanCIDRs}
      isFocused={isFocused}
    />
  );
}

function ViewerRoute({
  server,
  user,
  route,
  navigation,
}: AuthenticatedRouteProps & NativeStackScreenProps<RootStackParamList, 'Viewer'>) {
  const api = AuthenticatedApi({ server, user });
  return (
    <MediaViewerScreen
      api={api}
      photos={route.params.photos}
      initialIndex={route.params.initialIndex}
      serverId={server.id}
      userId={user.id}
      userRole={user.role}
      onClose={() => navigation.goBack()}
    />
  );
}

const MOBILE_APP_VERSION = '0.0.8';

function LoginRoute({ server, reload }: { server?: ServerConfig; reload: () => void }) {
  const login = useCallback(async (input: LoginSubmitInput) => {
    const serverId = server?.id ?? generateServerID();
    const api = createApiClient({
      baseURL: input.baseURL,
      serverId,
      lanCIDRs: () => getEnabledLANCIDRs(connectionStore.getState()),
      credentials: credentialsStore,
    });
    await api.healthz();
    const session = await api.login({
      username: input.username,
      password: input.password,
      deviceName: 'Android device',
      platform: 'android',
      appVersion: MOBILE_APP_VERSION,
    });

    const store = connectionStore.getState();
    if (server) {
      store.updateServer(server.id, {
        baseURL: input.baseURL,
        allowInsecureConfirmedAt: input.allowInsecureConfirmedAt,
      });
    } else {
      store.addServer({
        id: serverId,
        baseURL: input.baseURL,
        displayName: input.baseURL,
        allowInsecureConfirmedAt: input.allowInsecureConfirmedAt,
      });
      store.selectServer(serverId);
    }
    await store.flushPersistence();
    return session;
  }, [server]);

  return (
    <LoginScreen
      services={{
        server,
        lanCIDRs: getEnabledLANCIDRs(connectionStore.getState()),
        login,
        onAuthenticated: reload,
      }}
    />
  );
}

export function RootNavigator() {
  const { state, reload } = useBoot();
  return (
    <NavigationContainer>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        {state.status === 'loading' ? <RootStack.Screen name="Loading" component={LoadingScreen} /> : null}
        {state.status === 'needs-server' || state.status === 'needs-login' ? (
          <RootStack.Screen name="Login">
            {() => (
              <LoginRoute
                server={state.status === 'needs-login' ? state.server : undefined}
                reload={reload}
              />
            )}
          </RootStack.Screen>
        ) : null}
        {state.status === 'authenticated' ? (
          <RootStack.Screen name="Main">
            {() => <MainTabNavigator server={state.server} user={state.user} onSessionChanged={reload} />}
          </RootStack.Screen>
        ) : null}
        {state.status === 'authenticated' ? (
          <RootStack.Screen name="Viewer">
            {(props) => <ViewerRoute server={state.server} user={state.user} {...props} />}
          </RootStack.Screen>
        ) : null}
      </RootStack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  galleryRoot: { flex: 1, backgroundColor: colors.background },
  galleryTitle: { color: colors.ink, fontSize: 23, fontWeight: '800', paddingHorizontal: 20, paddingTop: spacing.lg, paddingBottom: spacing.xs },
  tabBar: { backgroundColor: colors.surface, borderTopColor: colors.border, minHeight: 56 },
  tabLabel: { fontSize: 13, fontWeight: '600' },
});
