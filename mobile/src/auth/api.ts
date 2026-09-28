import type {MobileSession} from './session';
import {version as appVersion} from '../../package.json';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function request<T>(server: string, path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(server + path, {
      ...init,
      signal: controller.signal,
      headers: {'Accept': 'application/json', ...init?.headers},
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = body?.error;
      throw new ApiError(response.status, error?.code ?? '', error?.message ?? '请求失败');
    }
    return (response.status === 204 ? {} : await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

type SessionResponse = {
  access_token: string;
  access_token_expires_at: string;
  refresh_token: string;
  refresh_token_expires_at: string;
  user: {username: string};
};

function sessionFromResponse(server: string, data: SessionResponse): MobileSession {
  return {
    server,
    username: data.user.username,
    accessToken: data.access_token,
    accessExpiresAt: data.access_token_expires_at,
    refreshToken: data.refresh_token,
    refreshExpiresAt: data.refresh_token_expires_at,
  };
}

export async function checkServer(server: string): Promise<void> {
  const health = await request<{status?: string; database?: string; storage?: string}>(server, '/healthz');
  if (health.status !== 'ok' || health.database !== 'ok' || health.storage !== 'ok') {
    throw new Error('服务器未就绪，或不是兼容的 77Photo 服务');
  }
}

export async function login(server: string, username: string, password: string): Promise<MobileSession> {
  const data = await request<SessionResponse>(server, '/api/v1/mobile/auth/login', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      username,
      password,
      device_name: '77Photo Android',
      platform: 'android',
      app_version: appVersion,
    }),
  });
  return sessionFromResponse(server, data);
}

export async function refresh(session: MobileSession): Promise<MobileSession> {
  const data = await request<SessionResponse>(session.server, '/api/v1/mobile/auth/refresh', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({refresh_token: session.refreshToken}),
  });
  return sessionFromResponse(session.server, data);
}

export async function me(session: MobileSession): Promise<string> {
  const data = await request<{username: string}>(session.server, '/api/v1/auth/me', {
    headers: {Authorization: `Bearer ${session.accessToken}`},
  });
  return data.username;
}

export async function revokeDevice(session: MobileSession): Promise<void> {
  await request(session.server, '/api/v1/mobile/auth/logout', {
    method: 'POST',
    headers: {Authorization: `Bearer ${session.accessToken}`},
  });
}
