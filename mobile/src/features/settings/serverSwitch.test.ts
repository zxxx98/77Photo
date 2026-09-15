import { Alert, type AlertButton } from 'react-native';
import { act, waitFor } from '@testing-library/react-native';

import type { UploadQueueSnapshot } from '../../native/NativeUploadQueue';
import { createConnectionStore } from '../../services/connection/store';
import { switchServerWithQueueDecision } from './serverSwitch';

const snapshot: UploadQueueSnapshot = {
  tasks: [{
    id: 'task-1', batchId: 'batch-1', contentUri: 'content://private/path', displayName: 'photo.jpg',
    mimeType: 'image/jpeg', size: 10, serverId: 'server-1', userId: 'user-1', deviceId: 'device-1',
    sessionId: null, folderId: 'folder-1', state: 'uploading', sentBytes: 2, attempts: 1,
    lastErrorCode: null, lastErrorMessage: null, createdAtEpochMs: 1, startedAtEpochMs: 1,
    completedAtEpochMs: null, nextRetryAtEpochMs: null, leaseOwner: 'service', leaseUntilEpochMs: 100,
  }],
  queued: 0,
  uploading: 1,
  succeeded: 0,
  failed: 0,
  sentBytes: 2,
  totalBytes: 10,
};

describe('server switching', () => {
  it('pauses then cancels old unfinished tasks before selecting another server', async () => {
    const store = createConnectionStore({
      storage: { getItem: async () => null, setItem: async () => undefined },
      idFactory: (() => {
        let index = 0;
        return () => `server-${++index}`;
      })(),
    });
    store.getState().addServer({ baseURL: 'https://one.test', displayName: 'One' });
    store.getState().addServer({ baseURL: 'https://two.test', displayName: 'Two' });
    const queue = {
      snapshot: jest.fn(async () => snapshot),
      pause: jest.fn(async () => undefined),
      cancel: jest.fn(async () => undefined),
    };
    let buttons: readonly AlertButton[] = [];
    const alert = jest.fn((...args: Parameters<typeof Alert.alert>) => {
      const nextButtons = args[2];
      buttons = Array.isArray(nextButtons) ? nextButtons : [];
    });

    const switching = switchServerWithQueueDecision({
      fromServerId: 'server-1',
      targetServerId: 'server-2',
      queue,
      store,
      alert,
    });
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(queue.pause).toHaveBeenCalledWith('server-1');
    expect(store.getState().selectedServerId).toBe('server-1');

    const cancel = buttons.find((button) => button.style === 'destructive');
    await act(async () => {
      await cancel?.onPress?.();
    });
    await switching;

    expect(queue.cancel).toHaveBeenCalledWith(['task-1']);
    expect(store.getState().selectedServerId).toBe('server-2');
  });

  it('resumes the current queue when the switch dialog is canceled', async () => {
    const store = createConnectionStore({
      storage: { getItem: async () => null, setItem: async () => undefined },
      idFactory: (() => {
        let index = 0;
        return () => `server-${++index}`;
      })(),
    });
    store.getState().addServer({ baseURL: 'https://one.test', displayName: 'One' });
    store.getState().addServer({ baseURL: 'https://two.test', displayName: 'Two' });
    const onStay = jest.fn(async () => undefined);
    let buttons: readonly AlertButton[] = [];
    const alert = jest.fn((...args: Parameters<typeof Alert.alert>) => {
      buttons = Array.isArray(args[2]) ? args[2] : [];
    });

    const switching = switchServerWithQueueDecision({
      fromServerId: 'server-1',
      targetServerId: 'server-2',
      queue: {
        snapshot: jest.fn(async () => snapshot),
        pause: jest.fn(async () => undefined),
        cancel: jest.fn(async () => undefined),
      },
      store,
      alert,
      onStay,
    });
    await waitFor(() => expect(alert).toHaveBeenCalled());

    await act(async () => {
      await buttons[0]?.onPress?.();
    });
    await switching;

    expect(onStay).toHaveBeenCalledTimes(1);
    expect(store.getState().selectedServerId).toBe('server-1');
  });
});
