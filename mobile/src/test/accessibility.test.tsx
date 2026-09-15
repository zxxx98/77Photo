import React from 'react';
import { render } from '@testing-library/react-native';

import { PrimaryButton } from '../components/ui';
import { UploadScreen } from '../features/upload/UploadScreen';
import type { ApiClient } from '../services/api/client';
import type { User } from '../services/api/types';
import type { ServerConfig } from '../services/connection/types';
import type { UploadQueueSnapshot } from '../native/NativeUploadQueue';

const server: ServerConfig = { id: 'server-1', baseURL: 'https://photo.test', displayName: 'Home', allowInsecureConfirmedAt: null };
const user: User = { id: 'user-1', username: 'user', role: 'user', is_active: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
const snapshot: UploadQueueSnapshot = { tasks: [], queued: 0, uploading: 0, succeeded: 0, failed: 0, sentBytes: 0, totalBytes: 0 };

describe('mobile accessibility contract', () => {
  it.each([1, 2])('keeps core actions discoverable at font scale %sx', async (fontScale) => {
    const api: Pick<ApiClient, 'listFolders' | 'getFolder'> = {
      listFolders: async () => ({ items: [] }),
      getFolder: async (id) => ({ id, owner_id: user.id, parent_id: null, name: 'Home', is_shared: false, photo_count: 0, child_folder_count: 0 }),
    };
    const view = await render(
      <UploadScreen
        api={api}
        server={server}
        user={user}
        queue={{
          enqueue: async () => [], snapshot: async () => snapshot, pause: async () => undefined,
          resume: async () => undefined, retryFailed: async () => undefined, cancel: async () => undefined,
        }}
      />,
      { wrapper: ({ children }: { children: React.ReactNode }) => <>{children}</> },
    );
    expect(fontScale).toBeGreaterThan(0);
    expect(view.getByRole('progressbar').props.accessibilityValue).toEqual({ min: 0, max: 100, now: 0 });
    expect(view.getByRole('button', { name: '选择照片或视频' })).toBeTruthy();
    expect(view.getByRole('button', { name: '选择目标文件夹' })).toBeTruthy();
  });

  it('labels standalone actions', async () => {
    const view = await render(<PrimaryButton label="继续上传" onPress={() => undefined} />);
    expect(view.getByRole('button', { name: '继续上传' })).toBeTruthy();
  });
});
