import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { createConnectionStore } from '../../services/connection/store';
import type { ServerConfig } from '../../services/connection/types';
import type { User } from '../../services/api/types';
import { LanRangesScreen } from './LanRangesScreen';
import { SettingsScreen } from './SettingsScreen';

const server: ServerConfig = {
  id: 'server-1', baseURL: 'https://photo.test', displayName: 'Home', allowInsecureConfirmedAt: null,
};
const admin: User = {
  id: 'user-1', username: 'admin', role: 'admin', is_active: true,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};

function renderWith(children: React.ReactElement) {
  return render(children);
}

describe('settings', () => {
  it('defaults to two uploads and keeps cellular uploads disabled', async () => {
    const store = createConnectionStore({ storage: { getItem: async () => null, setItem: async () => undefined } });
    const view = await renderWith(<SettingsScreen store={store} server={server} user={admin} />);

    expect(view.getByLabelText('同时上传数').props.selectedValue).toBe(2);
    expect(view.getByLabelText('允许移动网络上传').props.value).toBe(false);
    fireEvent(view.getByLabelText('同时上传数'), 'valueChange', 4);
    await waitFor(() => expect(store.getState().uploadConcurrency).toBe(4));
    fireEvent(view.getByLabelText('允许移动网络上传'), 'valueChange', true);
    await waitFor(() => expect(store.getState().cellularUploadEnabled).toBe(true));
  });

  it('rejects catch-all ranges and only allows disabling built-in ranges', async () => {
    const store = createConnectionStore({ storage: { getItem: async () => null, setItem: async () => undefined } });
    const view = await renderWith(<LanRangesScreen store={store} />);

    expect(view.getByTestId('builtin-cidr-192.168.0.0/16').props.disabled).toBe(false);
    await act(async () => { fireEvent(view.getByTestId('builtin-cidr-192.168.0.0/16'), 'valueChange', false); });
    await waitFor(() => expect(store.getState().builtInCIDREnabled['192.168.0.0/16']).toBe(false));
    fireEvent.changeText(view.getByLabelText('新增内网地址范围'), '0.0.0.0/0');
    await waitFor(() => expect(view.getByLabelText('新增内网地址范围').props.value).toBe('0.0.0.0/0'));
    fireEvent.press(view.getByRole('button', { name: '添加地址范围' }));
    await waitFor(() => expect(view.getByText('不能添加全网范围')).toBeTruthy());
  });
});
