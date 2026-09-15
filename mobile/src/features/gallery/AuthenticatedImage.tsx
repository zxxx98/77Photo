import React, { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { Image, type ImageProps } from 'react-native';

import {
  subscribeAuthenticatedImageContext,
} from '../../services/api/client';
import { credentialsStore } from '../../services/credentials';

type AuthenticatedImageContextValue = {
  serverId?: string;
  userId?: string;
  accessToken?: string;
};

const AuthenticatedImageContext = createContext<AuthenticatedImageContextValue>({});

export function AuthenticatedImageProvider({
  children,
  serverId,
  userId,
  accessToken,
}: PropsWithChildren<AuthenticatedImageContextValue>) {
  const [contextToken, setContextToken] = useState(accessToken);

  useEffect(() => setContextToken(accessToken), [accessToken]);
  useEffect(() => subscribeAuthenticatedImageContext(() => setContextToken(undefined)), []);

  return (
    <AuthenticatedImageContext.Provider value={{ serverId, userId, accessToken: contextToken }}>
      {children}
    </AuthenticatedImageContext.Provider>
  );
}

export type AuthenticatedImageProps = Omit<ImageProps, 'source'> & {
  uri: string;
  accessToken?: string;
  serverId?: string;
  userId?: string;
};

export function AuthenticatedImage({
  uri,
  accessToken,
  serverId,
  userId,
  ...props
}: AuthenticatedImageProps) {
  const context = useContext(AuthenticatedImageContext);
  const resolvedServerId = serverId ?? context.serverId;
  const [storedToken, setStoredToken] = useState<string | undefined>();
  const [contextCleared, setContextCleared] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setContextCleared(false);
    if (!accessToken && resolvedServerId) {
      credentialsStore
        .get(resolvedServerId)
        .then((credentials) => {
          if (!cancelled) setStoredToken(credentials?.accessToken);
        })
        .catch(() => {
          if (!cancelled) setStoredToken(undefined);
        });
    } else {
      setStoredToken(undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [accessToken, resolvedServerId, userId]);

  useEffect(() => subscribeAuthenticatedImageContext(() => {
    setStoredToken(undefined);
    setContextCleared(true);
  }), []);

  const token = contextCleared ? undefined : accessToken ?? context.accessToken ?? storedToken;
  const source = useMemo(
    () => ({
      uri,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    }),
    [token, uri],
  );
  return <Image {...props} source={source} />;
}
