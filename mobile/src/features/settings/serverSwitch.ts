import { Alert, type AlertButton } from 'react-native';

import type { UploadQueueSnapshot } from '../../native/NativeUploadQueue';
import type { ConnectionStore } from '../../services/connection/store';
import type { UploadQueueService } from '../upload/uploadService';

type QueueControls = Pick<UploadQueueService, 'snapshot' | 'pause' | 'cancel'>;

export type ServerSwitchLabels = {
  title: string;
  message: string;
  cancel: string;
  keep: string;
  discard: string;
};

export type ServerSwitchOptions = {
  fromServerId: string;
  targetServerId: string;
  queue: QueueControls;
  store: ConnectionStore;
  alert?: typeof Alert.alert;
  labels?: Partial<ServerSwitchLabels>;
  onStay?: () => void | Promise<void>;
  onSelected?: () => void;
};

const defaultLabels: ServerSwitchLabels = {
  title: '切换服务器',
  message: '当前服务器还有未完成上传，如何处理？',
  cancel: '留在当前服务器',
  keep: '保留队列',
  discard: '取消旧队列',
};

function unfinishedTaskIds(snapshot: UploadQueueSnapshot): string[] {
  return snapshot.tasks
    .filter((task) => task.state !== 'succeeded' && task.state !== 'canceled')
    .map((task) => task.id);
}

function selectServer(options: ServerSwitchOptions): void {
  options.store.getState().selectServer(options.targetServerId);
  options.onSelected?.();
}

/** Pauses the old server first, then makes the queue-retention choice explicit. */
export async function switchServerWithQueueDecision(options: ServerSwitchOptions): Promise<void> {
  if (options.fromServerId === options.targetServerId) return;

  const snapshot = await options.queue.snapshot(options.fromServerId);
  const taskIds = unfinishedTaskIds(snapshot);
  if (taskIds.length === 0) {
    selectServer(options);
    return;
  }

  await options.queue.pause(options.fromServerId);
  const labels = { ...defaultLabels, ...options.labels };
  const showAlert = options.alert ?? Alert.alert;

  await new Promise<void>((resolve) => {
    const buttons: AlertButton[] = [
      {
        text: labels.cancel,
        style: 'cancel',
        onPress: () => {
          Promise.resolve(options.onStay?.()).catch(() => undefined).finally(resolve);
        },
      },
      {
        text: labels.keep,
        onPress: () => {
          selectServer(options);
          resolve();
        },
      },
      {
        text: labels.discard,
        style: 'destructive',
        onPress: () => {
          options.queue.cancel(taskIds)
            .then(() => selectServer(options))
            .catch(() => undefined)
            .finally(resolve);
        },
      },
    ];
    showAlert(labels.title, labels.message, buttons);
  });
}
