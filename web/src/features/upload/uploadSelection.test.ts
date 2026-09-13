import { describe, expect, it } from 'vitest';
import { queuedItemsFromFiles } from './uploadSelection';

describe('upload selection', () => {
  it('converts selected files into queued items', () => {
    const first = new File(['one'], 'one.jpg', { type: 'image/jpeg' });
    const second = new File(['two'], 'two.png', { type: 'image/png' });

    expect(queuedItemsFromFiles([first, second])).toEqual([
      { file: first, status: 'queued', progress: 0 },
      { file: second, status: 'queued', progress: 0 },
    ]);
  });
});
