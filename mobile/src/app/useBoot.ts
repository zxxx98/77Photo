import { useCallback, useEffect, useState } from 'react';

import { createApiClient } from '../services/api/client';
import { credentialsStore } from '../services/credentials';
import { connectionStore, getEnabledLANCIDRs } from '../services/connection/store';
import { evaluateServerURL } from '../services/connection/policy';
import type { ServerConfig } from '../services/connection/types';
import type { User } from '../services/api/types';

export type BootState =
  | { status: 'loading' }
  | { status: 'needs-server' }
  | { status: 'needs-login'; server: ServerConfig }
  | { status: 'authenticated'; server: ServerConfig; user: User };

export function useBoot(): { state: BootState; reload: () => void } {
  const [state, setState] = useState<BootState>({ status: 'loading' });
  const [hydrated, setHydrated] = useState(false);
  const [revision, setRevision] = useState(0);
  const selectedServerId = connectionStore((value) => value.selectedServerId);
  const servers = connectionStore((value) => value.servers);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    connectionStore
      .getState()
      .hydrate()
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    const server = servers.find((candidate) => candidate.id === selectedServerId);
    if (!server) {
      setState({ status: 'needs-server' });
      return undefined;
    }
    const decision = evaluateServerURL(server.baseURL, getEnabledLANCIDRs(connectionStore.getState()));
    if (!decision.allowed) {
      setState({ status: 'needs-login', server });
      return undefined;
    }
    const api = createApiClient({
      baseURL: decision.normalizedURL,
      serverId: server.id,
      lanCIDRs: getEnabledLANCIDRs(connectionStore.getState()),
      credentials: credentialsStore,
    });
    api
      .me()
      .then((user) => {
        if (!cancelled) setState({ status: 'authenticated', server, user });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'needs-login', server });
      });
    return () => {
      cancelled = true;
    };
  }, [hydrated, revision, selectedServerId, servers]);

  return { state, reload };
}
