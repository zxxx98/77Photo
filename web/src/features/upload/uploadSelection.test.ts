import { describe, expect, it } from 'vitest';
import { queuedItemsFromFiles, selectionFileIsQueued, shouldAutoStartAfterSelection } from './uploadSelection';

describe('upload selection', () => {
  it('converts selected files into queued items', () => {
    const first = new File(['one'], 'one.jpg', { type: 'image/jpeg' });
    const second = new File(['two'], 'two.png', { type: 'image/png' });

    expect(queuedItemsFromFiles([first, second])).toEqual([
      { file: first, status: 'queued', progress: 0 },
      { file: second, status: 'queued', progress: 0 },
    ]);
  });

  it('pairs a MOV motion file with a matching still image', () => {
    const still = new File(['photo'], 'IMG_1234.JPG', { type: 'image/jpeg' });
    const motion = new File(['motion'], 'IMG_1234.MOV', { type: 'video/quicktime' });

    expect(queuedItemsFromFiles([still, motion])).toEqual([
      { file: still, liveVideo: motion, status: 'queued', progress: 0 },
    ]);
  });

  it('keeps unmatched MOV files as standalone uploads', () => {
    const motion = new File(['motion'], 'clip.mov', { type: 'video/quicktime' });

    expect(queuedItemsFromFiles([motion])).toEqual([
      { file: motion, status: 'queued', progress: 0 },
    ]);
  });

  it('treats both sides of a live photo pair as queued', () => {
    const still = new File(['photo'], 'IMG_1234.jpg', { type: 'image/jpeg' });
    const motion = new File(['motion'], 'IMG_1234.mov', { type: 'video/quicktime' });
    const items = queuedItemsFromFiles([still, motion]);

    expect(selectionFileIsQueued(still, items)).toBe(true);
    expect(selectionFileIsQueued(motion, items)).toBe(true);
  });

  it('requests an automatic upload when files are selected', () => {
    const file = new File(['data'], 'photo.jpg', { type: 'image/jpeg' });

    expect(shouldAutoStartAfterSelection([file])).toBe(true);
    expect(shouldAutoStartAfterSelection([])).toBe(false);
  });
});
