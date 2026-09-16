import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { ApiClient } from '../../services/api/client';
import type { Folder, User } from '../../services/api/types';
import type { Spec as PhotoPickerSpec } from '../../native/NativePhotoPicker';
import type { PickedMedia, UploadQueueSnapshot } from '../../native/NativeUploadQueue';
import { UploadScreen } from './UploadScreen';

const pickerItem: PickedMedia = {
  uri: 'content://media/photo-1',
  displayName: 'photo-1.jpg',
  mimeType: 'image/jpeg',
  size: 100,
};

const emptySnapshot: UploadQueueSnapshot = {
  tasks: [],
  queued: 0,
  uploading: 0,
  succeeded: 0,
  failed: 0,
  sentBytes: 0,
  totalBytes: 0,
};

function folder(overrides: Partial<Folder> = {}): Folder {
  return {
    id: 'folder-1',
    owner_id: 'user-1',
    parent_id: null,
    name: '旅行',
    is_shared: false,
    photo_count: 0,
    child_folder_count: 0,
    ...overrides,
  };
}

function api(): Pick<ApiClient, 'listFolders' | 'getFolder'> {
  return {
    listFolders: jest.fn(async () => ({ items: [folder()] })),
    getFolder: jest.fn(async (id: string) => folder({ id })),
  };
}

async function renderScreen(options: {
  queue?: Partial<Pick<
    import('../../native/NativeUploadQueue').Spec,
    'enqueue' | 'snapshot' | 'pause' | 'resume' | 'retryFailed' | 'cancel' | 'start'
  >>;
  picker?: Partial<PhotoPickerSpec>;
  api?: Pick<ApiClient, 'listFolders' | 'getFolder'>;
  user?: User;
  notificationPermission?: () => Promise<boolean>;
} = {}) {
  const queue = {
    enqueue: jest.fn(async () => ['task-1']),
    snapshot: jest.fn(async () => emptySnapshot),
    pause: jest.fn(async () => undefined),
    resume: jest.fn(async () => undefined),
    retryFailed: jest.fn(async () => undefined),
    cancel: jest.fn(async () => undefined),
    start: jest.fn(async () => undefined),
    ...options.queue,
  };
  const picker = {
    pick: jest.fn(async () => [pickerItem]),
    ...options.picker,
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const result = await render(
    <QueryClientProvider client={queryClient}>
      <UploadScreen
        api={options.api ?? api()}
        server={{ id: 'server-1', baseURL: 'https://photo.test', displayName: '家庭图库', allowInsecureConfirmedAt: null }}
        user={options.user ?? {
          id: 'user-1', username: 'admin', role: 'admin', is_active: true,
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        }}
        queue={queue}
        picker={picker}
        notificationsAllowed
        notificationPermission={options.notificationPermission}
        concurrency={2}
      />
    </QueryClientProvider>,
  );
  return { ...result, queue, picker };
}

describe('UploadScreen', () => {
  it('shows the Android 13 notification limitation when permission is denied', async () => {
    const rendered = await renderScreen({ notificationPermission: async () => false });

    await waitFor(() => expect(rendered.getByText(/通知权限未开启/)).toBeTruthy());
  });

  it('selects media, chooses a writable folder, enqueues, and starts the native service', async () => {
    const rendered = await renderScreen();

    await act(async () => {
      fireEvent.press(rendered.getByRole('button', { name: '选择照片或视频' }));
    });
    await waitFor(() => expect(rendered.getByText('已选择 1 项')).toBeTruthy());
    await act(async () => {
      fireEvent.press(rendered.getByRole('button', { name: '选择目标文件夹' }));
    });
    await waitFor(() => expect(rendered.getByTestId('folder-picker-folder-1')).toBeTruthy());
    await act(async () => {
      fireEvent.press(rendered.getByTestId('folder-picker-folder-1'));
    });
    await waitFor(() => expect(rendered.getByText('目标文件夹：旅行')).toBeTruthy());
    await act(async () => {
      fireEvent.press(rendered.getByRole('button', { name: '开始上传' }));
    });

    await waitFor(() => expect(rendered.queue.enqueue).toHaveBeenCalledWith(
      'server-1', 'user-1', 'folder-1', [pickerItem],
    ));
    expect(rendered.queue.start).toHaveBeenCalledWith('server-1', 'https://photo.test', 'user-1', 2, false, []);
  });

  it('offers retry for failed tasks without exposing a file path', async () => {
    const snapshot = { ...emptySnapshot, failed: 1, tasks: [{
      id: 'task-1', batchId: 'batch-1', contentUri: 'content://private/path', displayName: 'secret.jpg',
      mimeType: 'image/jpeg', size: 100, motionUri: null, motionDisplayName: null, motionMimeType: null, motionSize: null,
      serverId: 'server-1', userId: 'user-1', deviceId: 'device-1',
      sessionId: null, folderId: 'folder-1', state: 'failed' as const, sentBytes: 0, attempts: 1,
      lastErrorCode: 'NETWORK_ERROR', lastErrorMessage: 'offline', createdAtEpochMs: 1,
      startedAtEpochMs: null, completedAtEpochMs: null, nextRetryAtEpochMs: null,
      leaseOwner: null, leaseUntilEpochMs: null,
    }] };
    const rendered = await renderScreen({ queue: { snapshot: jest.fn(async () => snapshot) } });

    await waitFor(() => expect(rendered.getByText('有 1 项失败')).toBeTruthy());
    expect(rendered.queryByText('content://private/path')).toBeNull();
    await act(async () => {
      fireEvent.press(rendered.getByRole('button', { name: '重试失败项' }));
    });
    await waitFor(() => expect(rendered.queue.retryFailed).toHaveBeenCalledWith('server-1'));
  });

  it('shows task rows and confirms before canceling an unfinished task', async () => {
    const snapshot = { ...emptySnapshot, queued: 1, tasks: [{
      id: 'task-1', batchId: 'batch-1', contentUri: 'content://private/path', displayName: 'secret.jpg',
      mimeType: 'image/jpeg', size: 100, motionUri: null, motionDisplayName: null, motionMimeType: null, motionSize: null,
      serverId: 'server-1', userId: 'user-1', deviceId: 'device-1',
      sessionId: null, folderId: 'folder-1', state: 'queued' as const, sentBytes: 0, attempts: 0,
      lastErrorCode: null, lastErrorMessage: null, createdAtEpochMs: 1,
      startedAtEpochMs: null, completedAtEpochMs: null, nextRetryAtEpochMs: null,
      leaseOwner: null, leaseUntilEpochMs: null,
    }] };
    const rendered = await renderScreen({ queue: { snapshot: jest.fn(async () => snapshot) } });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

    await waitFor(() => expect(rendered.getByText('secret.jpg')).toBeTruthy());
    expect(rendered.getByText('排队中')).toBeTruthy();
    await act(async () => {
      fireEvent.press(rendered.getByRole('button', { name: '取消 secret.jpg' }));
    });

    expect(alert).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.arrayContaining([expect.objectContaining({ style: 'destructive' })]),
    );
    const buttons = alert.mock.calls[0]?.[2];
    const destructive = buttons?.find((button) => button.style === 'destructive');
    await act(async () => {
      destructive?.onPress?.();
    });
    await waitFor(() => expect(rendered.queue.cancel).toHaveBeenCalledWith(['task-1']));
    alert.mockRestore();
  });
});
