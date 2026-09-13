import { describe, expect, it } from 'vitest';

const sources = import.meta.glob([
  '../../app/App.tsx',
  '../gallery/GalleryWorkspace.tsx',
  '../folders/FoldersWorkspace.tsx',
  '../sharing/PublicSharePage.tsx',
], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function sourceEnding(path: string) {
  return Object.entries(sources).find(([key]) => key.endsWith(path))?.[1] ?? '';
}

describe('loading state integration', () => {
  it('uses content-shaped skeletons for page-level loading', () => {
    expect(sourceEnding('/GalleryWorkspace.tsx')).toContain('{loading && <GallerySkeleton />}');
    expect(sourceEnding('/FoldersWorkspace.tsx')).toContain('{loading && <FolderListSkeleton />}');
    expect(sourceEnding('/PublicSharePage.tsx')).toContain('<PublicShareSkeleton');
    expect(sourceEnding('/App.tsx')).toContain('<AppShellSkeleton />');
  });

  it('keeps the compact spinner only for incremental gallery loading', () => {
    const gallery = sourceEnding('/GalleryWorkspace.tsx');
    expect(gallery).toContain('loadingMore && <LoaderCircle');
    expect(gallery).not.toContain("t('gallery.loading')");
  });
});
