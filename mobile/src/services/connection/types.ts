export type ServerConfig = {
  id: string;
  baseURL: string;
  displayName: string;
  allowInsecureConfirmedAt: string | null;
};

export type ManualCIDR = {
  cidr: string;
  enabled: boolean;
};

export type ConnectionSettings = {
  servers: ServerConfig[];
  selectedServerId: string | null;
  builtInCIDREnabled: Record<string, boolean>;
  manualCIDRs: ManualCIDR[];
  uploadConcurrency: 1 | 2 | 3 | 4;
  cellularUploadEnabled: boolean;
};
