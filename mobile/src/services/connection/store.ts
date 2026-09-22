import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

import { parseCIDR } from './cidr';
import { DEFAULT_LAN_CIDRS, validateManualCIDR } from './policy';
import type { AppLanguage, ConnectionSettings, ManualCIDR, ServerConfig } from './types';

export const CONNECTION_SETTINGS_STORAGE_KEY = 'photo77.connection.settings.v1';

export type StorageLike = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export type UploadConcurrency = 1 | 2 | 3 | 4;

export type AddServerInput = {
  id?: string;
  baseURL: string;
  displayName: string;
  allowInsecureConfirmedAt?: string | null;
};

export type UpdateServerInput = Partial<Pick<ServerConfig, 'baseURL' | 'displayName' | 'allowInsecureConfirmedAt'>>;

export type ConnectionStoreState = ConnectionSettings & {
  hydrate: () => Promise<void>;
  flushPersistence: () => Promise<void>;
  addServer: (input: AddServerInput) => string;
  updateServer: (id: string, patch: UpdateServerInput) => void;
  removeServer: (id: string) => void;
  selectServer: (id: string | null) => void;
  setServerInsecureConfirmation: (id: string, confirmedAt: string | null) => void;
  setBuiltInCIDREnabled: (cidr: string, enabled: boolean) => void;
  addManualCIDR: (raw: string) => ReturnType<typeof validateManualCIDR>;
  removeManualCIDR: (cidr: string) => void;
  setManualCIDREnabled: (cidr: string, enabled: boolean) => void;
  setUploadConcurrency: (value: UploadConcurrency) => void;
  setCellularUploadEnabled: (enabled: boolean) => void;
  setLanguage: (language: AppLanguage) => void;
};

export type ConnectionStoreOptions = {
  storage?: StorageLike;
  idFactory?: () => string;
};

const defaultBuiltInCIDREnabled = (): Record<string, boolean> =>
  Object.fromEntries(DEFAULT_LAN_CIDRS.map((cidr) => [cidr, true]));

export const DEFAULT_CONNECTION_SETTINGS: ConnectionSettings = {
  servers: [],
  selectedServerId: null,
  builtInCIDREnabled: defaultBuiltInCIDREnabled(),
  manualCIDRs: [],
  uploadConcurrency: 2,
  cellularUploadEnabled: false,
  language: 'system',
};

export function generateServerID(): string {
  return `server-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isUploadConcurrency(value: unknown): value is UploadConcurrency {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function isAppLanguage(value: unknown): value is AppLanguage {
  return value === 'system' || value === 'zh' || value === 'en';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeServer(value: unknown): ServerConfig | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.id !== 'string' ||
    value.id.trim() === '' ||
    typeof value.baseURL !== 'string' ||
    typeof value.displayName !== 'string'
  ) {
    return null;
  }
  return {
    id: value.id,
    baseURL: value.baseURL,
    displayName: value.displayName,
    allowInsecureConfirmedAt:
      value.allowInsecureConfirmedAt === null || typeof value.allowInsecureConfirmedAt === 'string'
        ? value.allowInsecureConfirmedAt
        : null,
  };
}

function normalizeSettings(value: unknown): ConnectionSettings {
  if (!isRecord(value)) {
    return DEFAULT_CONNECTION_SETTINGS;
  }

  const servers: ServerConfig[] = [];
  if (Array.isArray(value.servers)) {
    for (const candidate of value.servers) {
      const server = normalizeServer(candidate);
      if (server && !servers.some((existing) => existing.id === server.id)) {
        servers.push(server);
      }
    }
  }

  const builtInCIDREnabled = defaultBuiltInCIDREnabled();
  if (isRecord(value.builtInCIDREnabled)) {
    for (const cidr of DEFAULT_LAN_CIDRS) {
      if (value.builtInCIDREnabled[cidr] === false) {
        builtInCIDREnabled[cidr] = false;
      }
    }
  }

  const manualCIDRs: ManualCIDR[] = [];
  if (Array.isArray(value.manualCIDRs)) {
    for (const candidate of value.manualCIDRs) {
      if (!isRecord(candidate) || typeof candidate.cidr !== 'string') {
        continue;
      }
      const validated = validateManualCIDR(candidate.cidr);
      if (
        validated.ok &&
        !manualCIDRs.some((existing) => existing.cidr === validated.normalized)
      ) {
        manualCIDRs.push({
          cidr: validated.normalized,
          enabled: candidate.enabled !== false,
        });
      }
    }
  }

  const selectedServerId =
    typeof value.selectedServerId === 'string' && servers.some((server) => server.id === value.selectedServerId)
      ? value.selectedServerId
      : servers[0]?.id ?? null;

  return {
    servers,
    selectedServerId,
    builtInCIDREnabled,
    manualCIDRs,
    uploadConcurrency: isUploadConcurrency(value.uploadConcurrency) ? value.uploadConcurrency : 2,
    cellularUploadEnabled: value.cellularUploadEnabled === true,
    language: isAppLanguage(value.language) ? value.language : 'system',
  };
}

function settingsFromState(state: ConnectionStoreState): ConnectionSettings {
  return {
    servers: state.servers,
    selectedServerId: state.selectedServerId,
    builtInCIDREnabled: state.builtInCIDREnabled,
    manualCIDRs: state.manualCIDRs,
    uploadConcurrency: state.uploadConcurrency,
    cellularUploadEnabled: state.cellularUploadEnabled,
    language: state.language,
  };
}

export function getEnabledLANCIDRs(settings: ConnectionSettings): string[] {
  const builtIn = DEFAULT_LAN_CIDRS.filter((cidr) => settings.builtInCIDREnabled[cidr] !== false);
  return [
    ...builtIn,
    ...settings.manualCIDRs.filter((entry) => entry.enabled).map((entry) => entry.cidr),
  ];
}

export function createConnectionStore(options: ConnectionStoreOptions = {}) {
  const storage: StorageLike = options.storage ?? AsyncStorage;
  const idFactory = options.idFactory ?? generateServerID;
  let writeQueue = Promise.resolve();

  const queuePersistence = (state: ConnectionStoreState): void => {
    const serialized = JSON.stringify(settingsFromState(state));
    writeQueue = writeQueue
      .catch(() => undefined)
      .then(() => storage.setItem(CONNECTION_SETTINGS_STORAGE_KEY, serialized));
  };

  return create<ConnectionStoreState>((set, get) => {
    const persistUpdate = (updater: (state: ConnectionSettings) => ConnectionSettings): void => {
      set((state) => updater(state));
      queuePersistence(get());
    };

    return {
      ...DEFAULT_CONNECTION_SETTINGS,
      builtInCIDREnabled: defaultBuiltInCIDREnabled(),
      hydrate: async () => {
        const raw = await storage.getItem(CONNECTION_SETTINGS_STORAGE_KEY);
        if (!raw) {
          return;
        }
        try {
          set(normalizeSettings(JSON.parse(raw)));
        } catch {
          // Keep defaults when a previous version wrote invalid JSON.
        }
      },
      flushPersistence: () => writeQueue,
      addServer: (input) => {
        let id = input.id ?? idFactory();
        if (input.id && get().servers.some((server) => server.id === id)) {
          return id;
        }
        while (get().servers.some((server) => server.id === id)) {
          id = generateServerID();
        }
        const server: ServerConfig = {
          id,
          baseURL: input.baseURL,
          displayName: input.displayName,
          allowInsecureConfirmedAt: input.allowInsecureConfirmedAt ?? null,
        };
        persistUpdate((state) => ({
          ...state,
          servers: [...state.servers, server],
          selectedServerId: state.selectedServerId ?? id,
        }));
        return id;
      },
      updateServer: (id, patch) => {
        persistUpdate((state) => ({
          ...state,
          servers: state.servers.map((server) => {
            if (server.id !== id) {
              return server;
            }
            const baseURLChanged = patch.baseURL !== undefined && patch.baseURL !== server.baseURL;
            return {
              ...server,
              ...patch,
              allowInsecureConfirmedAt: baseURLChanged
                ? patch.allowInsecureConfirmedAt !== undefined
                  ? patch.allowInsecureConfirmedAt
                  : null
                : patch.allowInsecureConfirmedAt !== undefined
                  ? patch.allowInsecureConfirmedAt
                  : server.allowInsecureConfirmedAt,
            };
          }),
        }));
      },
      removeServer: (id) => {
        persistUpdate((state) => {
          const servers = state.servers.filter((server) => server.id !== id);
          return {
            ...state,
            servers,
            selectedServerId:
              state.selectedServerId === id ? servers[0]?.id ?? null : state.selectedServerId,
          };
        });
      },
      selectServer: (id) => {
        if (id !== null && !get().servers.some((server) => server.id === id)) {
          return;
        }
        persistUpdate((state) => ({ ...state, selectedServerId: id }));
      },
      setServerInsecureConfirmation: (id, confirmedAt) => {
        persistUpdate((state) => ({
          ...state,
          servers: state.servers.map((server) =>
            server.id === id ? { ...server, allowInsecureConfirmedAt: confirmedAt } : server,
          ),
        }));
      },
      setBuiltInCIDREnabled: (cidr, enabled) => {
        if (!DEFAULT_LAN_CIDRS.includes(cidr as (typeof DEFAULT_LAN_CIDRS)[number])) {
          return;
        }
        persistUpdate((state) => ({
          ...state,
          builtInCIDREnabled: { ...state.builtInCIDREnabled, [cidr]: enabled },
        }));
      },
      addManualCIDR: (raw) => {
        const validated = validateManualCIDR(raw);
        if (!validated.ok) {
          return validated;
        }
        if (parseCIDR(validated.normalized) === null) {
          return { ok: false, reason: 'invalid_cidr' };
        }
        if (!get().manualCIDRs.some((entry) => entry.cidr === validated.normalized)) {
          persistUpdate((state) => ({
            ...state,
            manualCIDRs: [...state.manualCIDRs, { cidr: validated.normalized, enabled: true }],
          }));
        }
        return validated;
      },
      removeManualCIDR: (cidr) => {
        const normalized = parseCIDR(cidr)?.normalized;
        if (!normalized) {
          return;
        }
        persistUpdate((state) => ({
          ...state,
          manualCIDRs: state.manualCIDRs.filter((entry) => entry.cidr !== normalized),
        }));
      },
      setManualCIDREnabled: (cidr, enabled) => {
        const normalized = parseCIDR(cidr)?.normalized;
        if (!normalized) {
          return;
        }
        persistUpdate((state) => ({
          ...state,
          manualCIDRs: state.manualCIDRs.map((entry) =>
            entry.cidr === normalized ? { ...entry, enabled } : entry,
          ),
        }));
      },
      setUploadConcurrency: (value) => {
        persistUpdate((state) => ({ ...state, uploadConcurrency: value }));
      },
      setCellularUploadEnabled: (enabled) => {
        persistUpdate((state) => ({ ...state, cellularUploadEnabled: enabled }));
      },
      setLanguage: (language) => {
        if (!isAppLanguage(language)) return;
        persistUpdate((state) => ({ ...state, language }));
      },
    };
  });
}

export const connectionStore = createConnectionStore();

export type ConnectionStore = ReturnType<typeof createConnectionStore>;
