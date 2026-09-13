import { describe, expect, it } from 'vitest';

const shellSources = import.meta.glob('../app/App.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const appSource = Object.values(shellSources)[0] ?? '';
const workspaceSources = import.meta.glob([
  '../features/gallery/GalleryWorkspace.tsx',
  '../features/folders/FoldersWorkspace.tsx',
  '../features/upload/UploadWorkspace.tsx',
  '../features/viewer/Viewer.tsx',
  '../features/settings/SettingsWorkspace.tsx',
], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const sharingSources = import.meta.glob([
  '../features/sharing/ShareDialog.tsx',
  '../features/sharing/PublicSharePage.tsx',
], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const stateSources = import.meta.glob([
  '../features/loading/LoadingStates.tsx',
  '../features/folders/FolderEmptyState.tsx',
], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('translation coverage', () => {
  it('does not leave the previous shell and login literals behind', () => {
    expect(appSource).not.toContain('Private library');
    expect(appSource).not.toContain('Search your library');
    expect(appSource).not.toContain('Sign out');
  });

  it('places the authenticated language toggle in the topbar', () => {
    const topbarStart = appSource.indexOf('<header className="topbar">');
    const topbarEnd = appSource.indexOf('</header>', topbarStart);
    const accountStart = appSource.indexOf('<div className="account-area">');
    const signOutStart = appSource.indexOf('<button className="icon-button" aria-label={t(\'common.signOut\')}', accountStart);

    expect(topbarStart).toBeGreaterThanOrEqual(0);
    expect(topbarEnd).toBeGreaterThan(topbarStart);
    expect(appSource.slice(topbarStart, topbarEnd)).toContain('<LanguageToggle />');
    expect(appSource.slice(accountStart, signOutStart)).not.toContain('<LanguageToggle />');

    const pageSources = import.meta.glob([
      '../features/auth/LoginPage.tsx',
      '../features/sharing/PublicSharePage.tsx',
    ], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

    for (const source of Object.values(pageSources)) expect(source).toContain('<LanguageToggle />');
  });

  it('does not leave previous workspace literals behind', () => {
    const forbidden = ['>Timeline</', '>Folders</', '>Upload</', '>Destination<', '>Settings</', '>Retry</', 'Delete failed', '>Rescan files</'];

    for (const source of Object.values(workspaceSources)) {
      for (const phrase of forbidden) expect(source).not.toContain(phrase);
    }
  });

  it('does not leave previous sharing literals behind', () => {
    const forbidden = [
      'Public link',
      'Anyone with the link can view',
      'Link duration',
      'Optional password',
      'Creating link',
      'Copy link',
      'This shared item is unavailable',
      'Opening shared memories',
      'Password required',
      'View shared memories',
      'View only',
      'Loading memories',
      'No photos in this shared item',
      'Shared from a private 77Photo library',
    ];

    for (const source of Object.values(sharingSources)) {
      for (const phrase of forbidden) expect(source).not.toContain(phrase);
    }
  });

  it('keeps loading and empty states behind translation keys', () => {
    const forbidden = ['Start organizing here', 'Upload photos', 'New folder', 'Loading folders', 'Opening shared memories'];

    for (const source of Object.values(stateSources)) {
      for (const phrase of forbidden) expect(source).not.toContain(phrase);
    }
  });
});
