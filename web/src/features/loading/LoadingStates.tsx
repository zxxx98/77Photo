import type { ReactNode } from 'react';
import { useI18n } from '../../app/I18nProvider';
import type { TranslationKey } from '../../app/i18n';
import BrandMark from '../branding/BrandMark';

function LoadingRegion({ className, labelKey, children }: { className: string; labelKey: TranslationKey; children: ReactNode }) {
  const { t } = useI18n();
  return <div className={`loading-region ${className}`} role="status" aria-live="polite" aria-busy="true"><span className="sr-only">{t(labelKey)}</span><div aria-hidden="true">{children}</div></div>;
}

function SkeletonBlock({ className = '' }: { className?: string }) {
  return <span className={`skeleton-block ${className}`} />;
}

export function GallerySkeleton() {
  return <LoadingRegion className="gallery-skeleton" labelKey="gallery.loading"><div className="gallery-skeleton-heading"><SkeletonBlock className="skeleton-line skeleton-line-short" /><SkeletonBlock className="skeleton-line skeleton-line-tiny" /></div><div className="gallery-skeleton-grid">{Array.from({ length: 8 }, (_, index) => <div className="gallery-skeleton-item" key={index}><SkeletonBlock className="gallery-skeleton-tile" /><SkeletonBlock className="skeleton-line skeleton-line-caption" /></div>)}</div></LoadingRegion>;
}

export function FolderListSkeleton() {
  return <LoadingRegion className="folder-list-skeleton" labelKey="folders.loading">{Array.from({ length: 4 }, (_, index) => <div className="folder-skeleton-row" key={index}><SkeletonBlock className="folder-skeleton-icon" /><div className="folder-skeleton-copy"><SkeletonBlock className="skeleton-line skeleton-line-folder" /><SkeletonBlock className="skeleton-line skeleton-line-meta" /></div><SkeletonBlock className="folder-skeleton-action" /></div>)}</LoadingRegion>;
}

export function PublicShareSkeleton({ withHeading = false }: { withHeading?: boolean }) {
  return <LoadingRegion className={`public-share-skeleton ${withHeading ? 'public-share-skeleton-full' : ''}`} labelKey={withHeading ? 'public.openingMemories' : 'public.loadingMemories'}>{withHeading && <div className="public-skeleton-heading"><div><SkeletonBlock className="skeleton-line skeleton-line-short" /><SkeletonBlock className="skeleton-line skeleton-line-title" /></div><SkeletonBlock className="skeleton-line skeleton-line-tiny" /></div>}<div className="public-skeleton-grid">{Array.from({ length: 8 }, (_, index) => <div key={index}><SkeletonBlock className="public-skeleton-tile" /><SkeletonBlock className="skeleton-line skeleton-line-caption" /></div>)}</div></LoadingRegion>;
}

export function AppShellSkeleton() {
  return <LoadingRegion className="app-shell-skeleton" labelKey="shell.openingLibrary"><aside className="app-shell-skeleton-sidebar"><BrandMark /><SkeletonBlock className="skeleton-line skeleton-line-brand" />{Array.from({ length: 3 }, (_, index) => <SkeletonBlock className="app-shell-skeleton-nav" key={index} />)}</aside><main className="app-shell-skeleton-main"><div className="app-shell-skeleton-topbar"><SkeletonBlock className="app-shell-skeleton-search" /><SkeletonBlock className="app-shell-skeleton-button" /></div><div className="app-shell-skeleton-content"><SkeletonBlock className="skeleton-line skeleton-line-heading" /><SkeletonBlock className="skeleton-line skeleton-line-subheading" /><div className="gallery-skeleton-grid">{Array.from({ length: 8 }, (_, index) => <SkeletonBlock className="gallery-skeleton-tile" key={index} />)}</div></div></main></LoadingRegion>;
}

export function MapSkeleton() {
  return <LoadingRegion className="map-skeleton" labelKey="map.loading"><SkeletonBlock className="map-skeleton-canvas" /><div className="map-skeleton-panel"><SkeletonBlock className="skeleton-line skeleton-line-short" /><SkeletonBlock className="skeleton-line skeleton-line-tiny" /><div className="map-skeleton-grid">{Array.from({ length: 9 }, (_, index) => <SkeletonBlock className="map-skeleton-tile" key={index} />)}</div></div></LoadingRegion>;
}
