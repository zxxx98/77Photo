import React, { useMemo, useState } from 'react';
import { NavigationContainer, useNavigation } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator, type NativeStackNavigationProp, type NativeStackScreenProps } from '@react-navigation/native-stack';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';

import { Screen } from '../components/ui';
import { colors, spacing } from '../components/theme';
import { ConnectionSettingsScreen } from '../features/auth/ConnectionSettingsScreen';
import { LoginScreen } from '../features/auth/LoginScreen';
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
import { connectionStore, getEnabledLANCIDRs } from '../services/connection/store';
import type { ServerConfig } from '../services/connection/types';
import { useBoot } from './useBoot';
import '../i18n';

type RootStackParamList = {
  Loading: undefined;
  Connection: undefined;
  Login: undefined;
  Main: undefined;
  Viewer: { photos: readonly Photo[]; initialIndex?: number };
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
  const { t } = useTranslation();
  const api = AuthenticatedApi({ server, user });
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [view, setView] = useState<'timeline' | 'folders'>('timeline');
  const [folder, setFolder] = useState<{ id: string; name: string } | null>(null);

  if (folder) {
    return (
      <View style={styles.galleryRoot}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.back', '返回')}
          onPress={() => setFolder(null)}
          style={styles.folderBack}
        >
          <Text style={styles.folderBackText}>‹ {t('common.back', '返回')} · {folder.name}</Text>
        </Pressable>
        <GalleryScreen
          api={api}
          serverId={server.id}
          userId={user.id}
          folderId={folder.id}
          onPhotoPress={(photo, photos) => navigation.navigate('Viewer', {
            photos,
            initialIndex: Math.max(0, photos.findIndex((item) => item.id === photo.id)),
          })}
        />
      </View>
    );
  }

  return (
    <View style={styles.galleryRoot}>
      <View style={styles.gallerySwitcher} accessibilityRole="tablist">
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: view === 'timeline' }}
          onPress={() => setView('timeline')}
          style={[styles.switcherButton, view === 'timeline' && styles.switcherButtonActive]}
        >
          <Text style={styles.switcherText}>{t('gallery.timeline', '时间线')}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: view === 'folders' }}
          onPress={() => setView('folders')}
          style={[styles.switcherButton, view === 'folders' && styles.switcherButtonActive]}
        >
          <Text style={styles.switcherText}>{t('folders.title', '文件夹')}</Text>
        </Pressable>
      </View>
      {view === 'timeline' ? (
        <GalleryScreen
          api={api}
          serverId={server.id}
          userId={user.id}
          onPhotoPress={(photo, photos) => navigation.navigate('Viewer', {
            photos,
            initialIndex: Math.max(0, photos.findIndex((item) => item.id === photo.id)),
          })}
        />
      ) : (
        <FolderBrowserScreen
          api={api}
          serverId={server.id}
          userId={user.id}
          onFolderPress={(selected) => setFolder({ id: selected.id, name: selected.name })}
        />
      )}
    </View>
  );
}

function MainTabNavigator({ server, user, onSessionChanged }: AuthenticatedRouteProps) {
  return (
    <MainTabs.Navigator screenOptions={{ headerShown: false, tabBarActiveTintColor: colors.accent }}>
      <MainTabs.Screen name="Gallery">
        {() => <GalleryTab server={server} user={user} />}
      </MainTabs.Screen>
      <MainTabs.Screen name="Upload">
        {() => <UploadTab server={server} user={user} />}
      </MainTabs.Screen>
      <MainTabs.Screen name="Settings">
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
  const concurrency = connectionStore((state) => state.uploadConcurrency);
  const cellularUploadEnabled = connectionStore((state) => state.cellularUploadEnabled);
  const lanCIDRs = connectionStore((state) => getEnabledLANCIDRs(state));
  return (
    <UploadScreen
      api={api}
      server={server}
      user={user}
      concurrency={concurrency}
      cellularUploadEnabled={cellularUploadEnabled}
      lanCIDRs={lanCIDRs}
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

function LoginRoute({ server, reload }: { server: ServerConfig; reload: () => void }) {
  const api = useMemo(
    () => createApiClient({
      baseURL: server.baseURL,
      serverId: server.id,
      lanCIDRs: () => getEnabledLANCIDRs(connectionStore.getState()),
      credentials: credentialsStore,
    }),
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
  gallerySwitcher: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    backgroundColor: colors.background,
  },
  switcherButton: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  switcherButtonActive: { borderBottomColor: colors.accent },
  switcherText: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  folderBack: { minHeight: 48, justifyContent: 'center', paddingHorizontal: spacing.md },
  folderBackText: { color: colors.accent, fontSize: 16, fontWeight: '700' },
});
