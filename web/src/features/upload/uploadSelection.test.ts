import { describe, expect, it } from 'vitest';
import { queuedItemsFromFiles, shouldAutoStartAfterSelection } from './uploadSelection';

describe('upload selection', () => {
  it('converts selected files into queued items', () => {
    const first = new File(['one'], 'one.jpg', { type: 'image/jpeg' });
    const second = new File(['two'], 'two.png', { type: 'image/png' });

    expect(queuedItemsFromFiles([first, second])).toEqual([
      { file: first, status: 'queued', progress: 0 },
      { file: second, status: 'queued', progress: 0 },
    ]);
  });

  it('requests an automatic upload when files are selected', () => {
    const file = new File(['data'], 'photo.jpg', { type: 'image/jpeg' });

    expect(shouldAutoStartAfterSelection([file])).toBe(true);
    expect(shouldAutoStartAfterSelection([])).toBe(false);
  });
});
