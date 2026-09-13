import { describe, expect, it } from 'vitest';
import { createCopyLinkHandler, selectShareDuration, shareButtonLabel, shareCopy, shareDurations, successMessage } from './shareDialog';

describe('share dialog rules', () => {
  it('runs the copy action when the copy button is clicked', () => {
    let copyCalls = 0;
    const handleCopy = createCopyLinkHandler(async () => {
      copyCalls += 1;
    });

    handleCopy();

    expect(copyCalls).toBe(1);
  });

  it('selects the newly checked duration', () => {
    expect(selectShareDuration('1_day', '7_days')).toBe('7_days');
    expect(selectShareDuration('7_days', 'forever')).toBe('forever');
  });

  it('keeps copy contextual to the shared resource', () => {
    expect(shareCopy('photo', 'IMG_2048.jpg').title).toBe('Share photo');
    expect(shareCopy('folder', 'Family / Summer trip').createLabel).toBe('Create folder link');
    expect(shareButtonLabel('photo')).toBe('Share photo');
    expect(shareButtonLabel('folder')).toBe('Share folder');
  });

  it('describes successful sharing with the resource and duration', () => {
    expect(successMessage('photo', '7_days')).toContain('Photo shared for 7 days');
    expect(successMessage('folder', 'forever')).toContain('Folder shared forever');
  });

  it('returns resource-specific copy in both locales', () => {
    expect(shareCopy('photo', 'IMG_2048.jpg', 'zh').title).toBe('分享照片');
    expect(shareCopy('photo', 'IMG_2048.jpg', 'en').title).toBe('Share photo');
    expect(successMessage('folder', 'forever', 'zh')).toContain('文件夹已永久分享');
    expect(successMessage('folder', 'forever', 'en')).toContain('Folder shared forever');
  });

  it('offers exactly one checkbox choice for each duration', () => {
    expect(shareDurations).toEqual([
      '1_day',
      '7_days',
      'forever',
    ]);
    expect(selectShareDuration('forever', '1_day')).toBe('1_day');
  });
});
