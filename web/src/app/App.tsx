import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Folder, Image, LogOut, Menu, Search, Settings, Upload, X } from 'lucide-react';
import { createApiClient } from './api';
import { SessionStore } from './auth';
import { useI18n } from './I18nProvider';
import type { TranslationKey } from './i18n';
import { readPublicShareToken, readView, type AppView } from './routes';
import { openUploadPicker } from './uploadPicker';
import LoginPage from '../features/auth/LoginPage';
import SetupPage from '../features/auth/SetupPage';
import GalleryWorkspace from '../features/gallery/GalleryWorkspace';
import FoldersWorkspace from '../features/folders/FoldersWorkspace';
import UploadWorkspace from '../features/upload/UploadWorkspace';
import PublicSharePage from '../features/sharing/PublicSharePage';
import SettingsWorkspace from '../features/settings/SettingsWorkspace';
import type { UploadSelection } from '../features/upload/uploadSelection';
import LanguageToggle from '../features/i18n/LanguageToggle';
import BrandMark from '../features/branding/BrandMark';
import { AppShellSkeleton } from '../features/loading/LoadingStates';

type View = AppView;

const navItems: Array<{ id: View; labelKey: TranslationKey; icon: typeof Image }> = [
  { id: 'gallery', labelKey: 'shell.gallery', icon: Image },
  { id: 'folders', labelKey: 'shell.folders', icon: Folder },
  { id: 'settings', labelKey: 'shell.settings', icon: Settings },
];

export default function App() {
  const api = useMemo(() => createApiClient(), []);
  const store = useMemo(() => new SessionStore(api), [api]);
  const [view, setView] = useState<View>(() => readView(window.location.hash));
  const publicShareToken = readPublicShareToken(window.location.hash);
  const snapshot = useSyncExternalStore(store.subscribe, () => store.snapshot, () => store.snapshot);

  useEffect(() => { if (!publicShareToken) void store.restore(); }, [publicShareToken, store]);
  useEffect(() => {
    const handlePopState = () => setView(readView(window.location.hash));
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  if (publicShareToken) return <PublicSharePage api={api} token={publicShareToken} />;
  if (snapshot.status === 'loading') return <AppShellSkeleton />;
  if (snapshot.status === 'setup') return <SetupPage store={store} />;
  if (snapshot.status === 'unauthenticated') return <LoginPage store={store} />;
  return <AppShell api={api} store={store} view={view} onViewChange={(nextView) => { writeView(nextView); setView(nextView); }} />;
}

function AppShell({ api, store, view, onViewChange }: { api: ReturnType<typeof createApiClient>; store: SessionStore; view: View; onViewChange: (view: View) => void }) {
  const { t } = useI18n();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [uploadSelection, setUploadSelection] = useState<UploadSelection | null>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const selectionIdRef = useRef(0);
  const user = store.snapshot.user;
  const chooseUpload = useCallback(() => {
    openUploadPicker(() => onViewChange('upload'), pickerRef.current);
  }, [onViewChange]);
  const handlePickerChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    const id = selectionIdRef.current;
    selectionIdRef.current += 1;
    setUploadSelection({ id, files });
  }, []);
  const consumeUploadSelection = useCallback((id: number) => {
    setUploadSelection((current) => current?.id === id ? null : current);
  }, []);
  return (
    <div className="app-frame">
      <button className={`scrim ${sidebarOpen ? 'is-visible' : ''}`} aria-label={t('common.closeNavigation')} onClick={() => setSidebarOpen(false)} />
      <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`} aria-label={t('common.primaryNavigation')}>
        <div className="brand-lockup">
          <BrandMark />
          <div><strong>77Photo</strong><span>{t('shell.privateMemories')}</span></div>
          <button className="icon-button mobile-close" aria-label={t('common.closeNavigation')} onClick={() => setSidebarOpen(false)}><X size={19} /></button>
        </div>
        <nav className="primary-nav">
          <span className="nav-caption">{t('shell.library')}</span>
          {navItems.map(({ id, labelKey, icon: Icon }) => (
            <button key={id} className={`nav-item ${view === id ? 'is-active' : ''}`} onClick={() => { onViewChange(id); setSidebarOpen(false); }}>
              <Icon size={18} strokeWidth={1.7} /><span>{t(labelKey)}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="status-dot" aria-hidden="true" />
          <div><strong>{t('shell.privateLibrary')}</strong><span>{t('shell.storedOnServer')}</span></div>
        </div>
        <div className="account-area">
          <div className="avatar" aria-hidden="true">{user?.username.slice(0, 1).toUpperCase()}</div>
          <div className="account-copy"><strong>{user?.username}</strong><span>{user?.role === 'admin' ? t('shell.administrator') : t('shell.familyMember')}</span></div>
          <button className="icon-button" aria-label={t('common.signOut')} onClick={() => void store.logout()}><LogOut size={18} /></button>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <button className="icon-button menu-button" aria-label={t('common.openNavigation')} onClick={() => setSidebarOpen(true)}><Menu size={20} /></button>
          <label className="search-field">
            <Search size={18} aria-hidden="true" />
            <span className="sr-only">{t('common.search')}</span>
            <input placeholder={t('common.search')} disabled aria-label={t('common.search')} />
          </label>
          <div className="topbar-actions">
            <LanguageToggle />
            <button className="button button-primary upload-button" onClick={chooseUpload}><Upload size={17} /> <span>{t('common.upload')}</span></button>
          </div>
          <input ref={pickerRef} className="sr-only" type="file" accept="image/jpeg,image/png,video/mp4,video/webm,video/quicktime,.mov" multiple tabIndex={-1} aria-hidden="true" onChange={handlePickerChange} />
        </header>
        <div className="content-scroll"><Workspace api={api} currentUser={user!} view={view} uploadSelection={uploadSelection} onUploadSelectionConsumed={consumeUploadSelection} onUpload={chooseUpload} /></div>
      </main>
      <nav className="mobile-nav" aria-label={t('common.mobileNavigation')}>
        {navItems.slice(0, 2).map(({ id, labelKey, icon: Icon }) => (
          <button key={id} className={`mobile-nav-item ${view === id ? 'is-active' : ''}`} onClick={() => onViewChange(id)}><Icon size={19} /><span>{t(labelKey)}</span></button>
        ))}
        <button className={`mobile-nav-item ${view === 'settings' ? 'is-active' : ''}`} onClick={() => onViewChange('settings')}><Settings size={19} /><span>{t('shell.settings')}</span></button>
      </nav>
    </div>
  );
}

function Workspace({ api, currentUser, view, uploadSelection, onUploadSelectionConsumed, onUpload }: { api: ReturnType<typeof createApiClient>; currentUser: NonNullable<SessionStore['snapshot']['user']>; view: View; uploadSelection: UploadSelection | null; onUploadSelectionConsumed: (id: number) => void; onUpload: () => void }) {
  if (view === 'gallery') return <GalleryWorkspace api={api} />;
  if (view === 'folders') return <FoldersWorkspace api={api} onUpload={onUpload} />;
  if (view === 'upload') return <UploadWorkspace api={api} selection={uploadSelection} onSelectionConsumed={onUploadSelectionConsumed} />;
  if (view === 'settings') return <SettingsWorkspace api={api} currentUser={currentUser} />;
  return null;
}

function writeView(view: View) {
  window.history.pushState({}, '', `#/${view}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
