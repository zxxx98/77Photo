import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../app/I18nProvider';
import {
  AppShellSkeleton,
  FolderListSkeleton,
  GallerySkeleton,
  PublicShareSkeleton,
} from './LoadingStates';

function render(node: ReactNode) {
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
}

describe('loading skeletons', () => {
  it('announces loading while hiding decorative blocks', () => {
    const markup = render(<GallerySkeleton />);

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('class="sr-only"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('gallery-skeleton-tile');
  });

  it('matches each destination shape', () => {
    expect(render(<FolderListSkeleton />).match(/folder-skeleton-row/g) ?? []).toHaveLength(4);
    expect(render(<PublicShareSkeleton />)).toContain('public-skeleton-grid');
    expect(render(<AppShellSkeleton />)).toContain('app-shell-skeleton');
  });

});
