import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { RootNavigator } from './navigation';

jest.mock('react-native-screens', () => {
  const ReactNative = require('react-native');
  return {
    ScreenStack: ReactNative.View,
    ScreenStackItem: ReactNative.View,
    ScreenStackHeaderConfig: ReactNative.View,
    ScreenStackHeaderSubview: ReactNative.View,
    ScreenStackHeaderLeftView: ReactNative.View,
    ScreenStackHeaderCenterView: ReactNative.View,
    ScreenStackHeaderRightView: ReactNative.View,
    ScreenStackHeaderSearchBarView: ReactNative.View,
    ScreenStackHeaderBackButtonImage: ReactNative.View,
    SearchBar: ReactNative.View,
    compatibilityFlags: {},
    isSearchBarAvailableForCurrentPlatform: () => false,
  };
});

jest.mock('react-native-safe-area-context', () => {
  const ReactNative = require('react-native');
  const ReactModule = require('react');
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
    SafeAreaView: ({ children, ...props }: { children: React.ReactNode }) =>
      ReactModule.createElement(ReactNative.View, props, children),
    SafeAreaInsetsContext: ReactModule.createContext(insets),
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets,
    },
    useSafeAreaInsets: () => insets,
  };
});

jest.mock('./useBoot', () => ({
  useBoot: () => ({
    state: {
      status: 'authenticated',
      server: {
        id: 'server-1',
        baseURL: 'https://photo.test',
        displayName: 'Home',
        allowInsecureConfirmedAt: null,
      },
      user: {
        id: 'user-1',
        username: 'tester',
        role: 'user',
        is_active: true,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    },
    reload: jest.fn(),
  }),
}));

jest.mock('../services/api/client', () => ({
  createApiClient: () => ({ logout: jest.fn() }),
}));

jest.mock('../features/gallery/GalleryScreen', () => ({ GalleryScreen: () => null }));
jest.mock('../features/folders/FolderBrowserScreen', () => ({ FolderBrowserScreen: () => null }));
jest.mock('../features/upload/UploadScreen', () => ({ UploadScreen: () => null }));
jest.mock('../features/viewer/MediaViewerScreen', () => ({ MediaViewerScreen: () => null }));
jest.mock('../features/auth/LoginScreen', () => ({ LoginScreen: () => null }));

describe('RootNavigator', () => {
  it('pushes the LAN range editor and returns to the existing Settings tab', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rendered = await render(
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <RootNavigator />
        </QueryClientProvider>
      </SafeAreaProvider>,
    );

    fireEvent.press(rendered.getByLabelText('设置, tab, 4 of 4'));
    await waitFor(() => expect(rendered.getByRole('button', { name: '编辑内网地址范围' })).toBeTruthy());
    fireEvent.press(rendered.getByRole('button', { name: '编辑内网地址范围' }));

    await waitFor(() => expect(rendered.getByText('内网地址范围')).toBeTruthy());
    fireEvent.press(rendered.getByRole('button', { name: '返回' }));

    await waitFor(() => expect(rendered.getByRole('button', { name: '编辑内网地址范围' })).toBeTruthy());
  });
});
