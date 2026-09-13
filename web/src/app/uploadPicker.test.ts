import { describe, expect, it, vi } from 'vitest';
import { openUploadPicker } from './uploadPicker';

describe('upload picker action', () => {
  it('navigates to upload and opens the native picker in one click', () => {
    const events: string[] = [];
    const picker = { click: vi.fn(() => events.push('picker')) } as unknown as HTMLInputElement;

    openUploadPicker(() => events.push('navigate'), picker);

    expect(events).toEqual(['navigate', 'picker']);
  });
});
