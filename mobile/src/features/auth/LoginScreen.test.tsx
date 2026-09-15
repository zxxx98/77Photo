import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { ServerConfig } from '../../services/connection/types';
import { LoginScreen, type LoginScreenServices } from './LoginScreen';

function servicesFor(baseURL: string, overrides: Partial<LoginScreenServices> = {}): LoginScreenServices {
  const server: ServerConfig = {
    id: 'server-1',
    baseURL,
    displayName: 'Home',
    allowInsecureConfirmedAt: null,
  };
  return {
    server,
    lanCIDRs: ['192.168.0.0/16'],
    api: {
      healthz: jest.fn(async () => ({
        status: 'ok' as const,
        database: 'ok' as const,
        storage: 'ok' as const,
        request_id: 'req-health',
      })),
      login: jest.fn(async () => ({
        access_token: 'access-1',
        access_token_expires_at: '2026-09-15T12:15:00.000Z',
        refresh_token: 'refresh-1',
        refresh_token_expires_at: '2026-12-14T12:00:00.000Z',
        device: {
          id: 'device-1',
          user_id: 'user-1',
          name: 'Pixel 9',
          platform: 'android' as const,
          app_version: '1.0.0',
          created_at: '2026-09-15T12:00:00.000Z',
          last_seen_at: '2026-09-15T12:00:00.000Z',
        },
        user: {
          id: 'user-1',
          username: 'admin',
          role: 'admin' as const,
          is_active: true,
          created_at: '2026-09-15T12:00:00.000Z',
          updated_at: '2026-09-15T12:00:00.000Z',
        },
      })),
    },
    onAuthenticated: jest.fn(),
    ...overrides,
  };
}

describe('LoginScreen', () => {
  it('checks server health before HTTPS login', async () => {
    const services = servicesFor('https://photo.example');
    await render(<LoginScreen services={services} />);

    await fireEvent.changeText(screen.getByLabelText('用户名'), 'admin');
    await fireEvent.changeText(screen.getByLabelText('密码'), 'correct horse battery staple');
    await fireEvent.press(screen.getByRole('button', { name: '安全登录' }));

    await waitFor(() => expect(services.api.login).toHaveBeenCalled());
    expect((services.api.healthz as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (services.api.login as jest.Mock).mock.invocationCallOrder[0],
    );
    expect(services.onAuthenticated).toHaveBeenCalled();
  });

  it('shows the LAN warning and permits an explicit HTTP login', async () => {
    const services = servicesFor('http://192.168.1.9:8080');
    await render(<LoginScreen services={services} />);

    expect(screen.getByText(/内网未加密/)).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('用户名'), 'admin');
    await fireEvent.changeText(screen.getByLabelText('密码'), 'correct horse battery staple');
    await fireEvent.press(screen.getByRole('button', { name: '安全登录' }));

    await waitFor(() => expect(services.api.login).toHaveBeenCalled());
  });

  it('blocks public HTTP before making a request', async () => {
    const services = servicesFor('http://8.8.8.8');
    await render(<LoginScreen services={services} />);

    expect(screen.getByText(/不允许使用未加密连接/)).toBeTruthy();
    expect(services.api.healthz).not.toHaveBeenCalled();
    expect(services.api.login).not.toHaveBeenCalled();
  });

  it('shows a loading state while login is pending', async () => {
    let releaseLogin: (() => void) | undefined;
    const services = servicesFor('https://photo.example', {
      api: {
        healthz: jest.fn(async () => ({
          status: 'ok' as const,
          database: 'ok' as const,
          storage: 'ok' as const,
          request_id: 'req-health',
        })),
        login: jest.fn(async () => {
          await new Promise<void>((resolve) => {
            releaseLogin = resolve;
          });
          return {} as never;
        }),
      },
    });
    await render(<LoginScreen services={services} />);
    await fireEvent.changeText(screen.getByLabelText('用户名'), 'admin');
    await fireEvent.changeText(screen.getByLabelText('密码'), 'correct horse battery staple');
    const press = fireEvent.press(screen.getByRole('button', { name: '安全登录' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '安全登录' }).props.accessibilityState).toEqual(
        expect.objectContaining({ busy: true }),
      ),
    );
    await act(async () => {
      releaseLogin?.();
      await press;
    });
  });

  it('maps unsupported mobile routes and invalid credentials', async () => {
    const unsupported = servicesFor('https://photo.example', {
      api: {
        healthz: jest.fn(async () => ({
          status: 'ok' as const,
          database: 'ok' as const,
          storage: 'ok' as const,
          request_id: 'req-health',
        })),
        login: jest.fn(async () => {
          throw new Error('SERVER_MOBILE_API_UNSUPPORTED');
        }),
      },
    });
    await render(<LoginScreen services={unsupported} />);
    await fireEvent.changeText(screen.getByLabelText('用户名'), 'admin');
    await fireEvent.changeText(screen.getByLabelText('密码'), 'correct horse battery staple');
    await fireEvent.press(screen.getByRole('button', { name: '安全登录' }));
    await waitFor(() => expect(screen.getByText(/不支持移动端登录/)).toBeTruthy());

    await cleanup();
    const invalid = servicesFor('https://photo.example', {
      api: {
        healthz: jest.fn(async () => ({
          status: 'ok' as const,
          database: 'ok' as const,
          storage: 'ok' as const,
          request_id: 'req-health',
        })),
        login: jest.fn(async () => {
          throw Object.assign(new Error('invalid'), { code: 'INVALID_CREDENTIALS' });
        }),
      },
    });
    await render(<LoginScreen services={invalid} />);
    await fireEvent.changeText(screen.getByLabelText('用户名'), 'admin');
    await fireEvent.changeText(screen.getByLabelText('密码'), 'wrong');
    await fireEvent.press(screen.getByRole('button', { name: '安全登录' }));
    await waitFor(() => expect(screen.getByText(/用户名或密码不正确/)).toBeTruthy());
  });
});
