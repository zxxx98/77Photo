import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { ServerConfig } from '../../services/connection/types';
import { LoginScreen, type LoginScreenServices } from './LoginScreen';

function session() {
  return {
    access_token: 'access-1',
    access_token_expires_at: '2026-09-22T13:30:00.000Z',
    refresh_token: 'refresh-1',
    refresh_token_expires_at: '2026-12-21T13:15:00.000Z',
    device: {
      id: 'device-1',
      user_id: 'user-1',
      name: 'Android device',
      platform: 'android' as const,
      app_version: '0.0.6',
      created_at: '2026-09-22T13:15:00.000Z',
      last_seen_at: '2026-09-22T13:15:00.000Z',
    },
    user: {
      id: 'user-1',
      username: 'admin',
      role: 'admin' as const,
      is_active: true,
      created_at: '2026-09-11T12:00:00.000Z',
      updated_at: '2026-09-11T12:00:00.000Z',
    },
  };
}

function servicesFor(server?: ServerConfig, overrides: Partial<LoginScreenServices> = {}): LoginScreenServices {
  return {
    server,
    lanCIDRs: ['192.168.0.0/16'],
    login: jest.fn(async () => session()),
    onAuthenticated: jest.fn(),
    ...overrides,
  };
}

describe('LoginScreen', () => {
  it('masks the password until the visibility control is pressed', async () => {
    await render(<LoginScreen services={servicesFor()} />);
    expect(screen.getByLabelText('密码').props.secureTextEntry).toBe(true);
    await fireEvent.press(screen.getByRole('button', { name: '显示密码' }));
    expect(screen.getByLabelText('密码').props.secureTextEntry).toBe(false);
    await fireEvent.press(screen.getByRole('button', { name: '隐藏密码' }));
    expect(screen.getByLabelText('密码').props.secureTextEntry).toBe(true);
  });

  it('puts the server URL and account credentials on the same first-time login screen', async () => {
    const services = servicesFor();
    await render(<LoginScreen services={services} />);

    expect(screen.getByLabelText('服务器地址')).toBeTruthy();
    expect(screen.getByLabelText('用户名')).toBeTruthy();
    expect(screen.getByLabelText('密码')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('服务器地址'), 'https://photo.example/');
    await fireEvent.changeText(screen.getByLabelText('用户名'), 'admin');
    await fireEvent.changeText(screen.getByLabelText('密码'), 'correct horse battery staple');
    await fireEvent.press(screen.getByRole('button', { name: '安全登录' }));

    await waitFor(() => expect(services.login).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: 'https://photo.example',
      username: 'admin',
      password: 'correct horse battery staple',
      allowInsecureConfirmedAt: null,
    })));
    expect(services.onAuthenticated).toHaveBeenCalled();
  });

  it('prefills an existing server and requires confirmation before LAN HTTP login', async () => {
    const services = servicesFor({
      id: 'server-1',
      baseURL: 'http://192.168.1.9:8080',
      displayName: 'Home',
      allowInsecureConfirmedAt: null,
    });
    await render(<LoginScreen services={services} />);

    expect(screen.getByDisplayValue('http://192.168.1.9:8080')).toBeTruthy();
    expect(screen.getByText(/内网未加密/)).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('用户名'), 'admin');
    await fireEvent.changeText(screen.getByLabelText('密码'), 'correct horse battery staple');

    expect(screen.getByRole('button', { name: '安全登录' }).props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );
    await fireEvent.press(screen.getByRole('checkbox', { name: '确认在内网使用未加密 HTTP' }));
    await fireEvent.press(screen.getByRole('button', { name: '安全登录' }));

    await waitFor(() => expect(services.login).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: 'http://192.168.1.9:8080',
      allowInsecureConfirmedAt: expect.any(String),
    })));
  });

  it('reports local credential persistence failures instead of claiming the server is unavailable', async () => {
    const services = servicesFor({
      id: 'server-1',
      baseURL: 'https://photo.example',
      displayName: 'Home',
      allowInsecureConfirmedAt: null,
    }, {
      login: jest.fn(async () => {
        throw Object.assign(new Error('NativeCredentials is unavailable'), { code: 'CREDENTIALS_ERROR' });
      }),
    });
    await render(<LoginScreen services={services} />);
    await fireEvent.changeText(screen.getByLabelText('用户名'), 'admin');
    await fireEvent.changeText(screen.getByLabelText('密码'), 'correct horse battery staple');
    await fireEvent.press(screen.getByRole('button', { name: '安全登录' }));

    await waitFor(() => expect(screen.getByText(/无法在设备上安全保存登录凭据/)).toBeTruthy());
  });

  it('maps invalid credentials and keeps a loading state while login is pending', async () => {
    let releaseLogin: (() => void) | undefined;
    const services = servicesFor({
      id: 'server-1',
      baseURL: 'https://photo.example',
      displayName: 'Home',
      allowInsecureConfirmedAt: null,
    }, {
      login: jest.fn(async () => {
        await new Promise<void>((resolve) => {
          releaseLogin = resolve;
        });
        throw Object.assign(new Error('invalid'), { code: 'INVALID_CREDENTIALS' });
      }),
    });
    await render(<LoginScreen services={services} />);
    await fireEvent.changeText(screen.getByLabelText('用户名'), 'admin');
    await fireEvent.changeText(screen.getByLabelText('密码'), 'wrong');
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
    await waitFor(() => expect(screen.getByText(/用户名或密码不正确/)).toBeTruthy());
  });
});
