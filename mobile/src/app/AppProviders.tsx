import React, { type PropsWithChildren, useEffect, useState } from 'react';
import { StatusBar, useColorScheme } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import i18n, { resolveLanguage } from '../i18n';
import { connectionStore } from '../services/connection/store';
import '../i18n';

export function AppProviders({ children }: PropsWithChildren) {
  const [queryClient] = useState(() => new QueryClient());
  const dark = useColorScheme() === 'dark';
  const language = connectionStore((state) => state.language);
  useEffect(() => {
    i18n.changeLanguage(resolveLanguage(language)).catch(() => undefined);
  }, [language]);
  return (
    <SafeAreaProvider>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </SafeAreaProvider>
  );
}
