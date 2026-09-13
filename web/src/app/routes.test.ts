import { describe, expect, it } from 'vitest';
import { readPublicShareToken, readView } from './routes';

describe('hash routes', () => {
  it('accepts only a complete public share route', () => {
    expect(readPublicShareToken('#/share/sl_abc')).toBe('sl_abc');
    expect(readPublicShareToken('#/gallery')).toBeNull();
    expect(readPublicShareToken('#/share/')).toBeNull();
    expect(readPublicShareToken('#/share/sl_abc/photos')).toBeNull();
  });

  it('falls back from the removed sharing route to the gallery', () => {
    expect(readView('#/sharing')).toBe('gallery');
  });

  it('keeps upload retry while removing the redundant start action', () => {
    const sources = import.meta.glob('../features/upload/UploadWorkspace.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const source = Object.values(sources)[0] ?? '';
    expect(source).not.toContain('Start upload');
    expect(source).toContain("t('common.retry')");
  });
});
