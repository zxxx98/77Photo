export type AppView = 'gallery' | 'folders' | 'settings' | 'upload';

const appViews: AppView[] = ['gallery', 'folders', 'settings', 'upload'];

export function readPublicShareToken(hash: string): string | null {
  const match = /^#\/share\/([^/]+)$/.exec(hash);
  return match?.[1] ?? null;
}

export function readView(hash: string): AppView {
  const value = hash.replace(/^#\/?/, '') as AppView;
  return appViews.includes(value) ? value : 'gallery';
}
