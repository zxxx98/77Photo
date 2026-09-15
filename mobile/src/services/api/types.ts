export type User = {
  id: string;
  username: string;
  role: 'admin' | 'user';
  is_active: boolean;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type MobileDevice = {
  id: string;
  user_id: string;
  name: string;
  platform: 'android' | 'ios';
  app_version: string;
  created_at: string;
  last_seen_at: string;
  revoked_at?: string | null;
};

export type MobileSessionResponse = {
  access_token: string;
  access_token_expires_at: string;
  refresh_token: string;
  refresh_token_expires_at: string;
  device: MobileDevice;
  user: User;
};

export type MobileLoginInput = {
  username: string;
  password: string;
  deviceName: string;
  platform: 'android' | 'ios';
  appVersion: string;
};

export type HealthResponse = {
  status: 'ok' | 'degraded';
  database: 'ok' | 'unavailable';
  storage: 'ok' | 'unavailable';
  request_id: string;
};

export type Photo = {
  id: string;
  owner_id: string;
  folder_id: string;
  filename: string;
  mime_type: string;
  size: number;
  width?: number;
  height?: number;
  captured_at: string;
  [key: string]: unknown;
};

export type PhotoPage = {
  items: Photo[];
  next_cursor: string | null;
};

export type Folder = {
  id: string;
  owner_id: string;
  parent_id: string | null;
  name: string;
  is_shared: boolean;
  inherited_permission?: 'read' | 'write';
  photo_count: number;
  child_folder_count: number;
  [key: string]: unknown;
};

export type ErrorPayload = {
  error?: {
    code?: string;
    message?: string;
    request_id?: string;
    details?: Record<string, unknown>;
  };
};
