import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Folder, Image, LogOut, Menu, Search, Settings, Share2, Upload, X } from 'lucide-react';
import { createApiClient } from './api';
import { SessionStore } from './auth';
import { openUploadPicker } from './uploadPicker';
import LoginPage from '../features/auth/LoginPage';
import GalleryWorkspace from '../features/gallery/GalleryWorkspace';
import FoldersWorkspace from '../features/folders/FoldersWorkspace';
import UploadWorkspace from '../features/upload/UploadWorkspace';
import SharingWorkspace from '../features/sharing/SharingWorkspace';
import SettingsWorkspace from '../features/settings/SettingsWorkspace';
import type { UploadSelection } from '../features/upload/uploadSelection';

type View = 'gallery' | 'folders' | 'sharing' | 'settings' | 'upload';

const navItems: Array<{ id: View; label: string; icon: typeof Image }> = [
  { id: 'gallery', label: 'Gallery', icon: Image },
  { id: 'folders', label: 'Folders', icon: Folder },
  { id: 'sharing', label: 'Sharing', icon: Share2 },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export default function App() {
  const api = useMemo(() => createApiClient(), []);
  const store = useMemo(() => new SessionStore(api), [api]);
  const [view, setView] = useState<View>(() => readView());
  const snapshot = useSyncExternalStore(store.subscribe, () => store.snapshot, () => store.snapshot);

  useEffect(() => { void store.restore(); }, [store]);
  useEffect(() => {
    const handlePopState = () => setView(readView());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  if (snapshot.status === 'loading') return <LoadingScreen />;
  if (snapshot.status === 'unauthenticated') return <LoginPage store={store} />;
  return <AppShell api={api} store={store} view={view} onViewChange={(nextView) => { writeView(nextView); setView(nextView); }} />;
}

function AppShell({ api, store, view, onViewChange }: { api: ReturnType<typeof createApiClient>; store: SessionStore; view: View; onViewChange: (view: View) => void }) {
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
      <button className={`scrim ${sidebarOpen ? 'is-visible' : ''}`} aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />
      <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`} aria-label="Primary navigation">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">77</span>
          <div><strong>77Photo</strong><span>private memories</span></div>
          <button className="icon-button mobile-close" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}><X size={19} /></button>
        </div>
        <nav className="primary-nav">
          <span className="nav-caption">Library</span>
          {navItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${view === id ? 'is-active' : ''}`} onClick={() => { onViewChange(id); setSidebarOpen(false); }}>
              <Icon size={18} strokeWidth={1.7} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="status-dot" aria-hidden="true" />
          <div><strong>Private library</strong><span>Stored on your server</span></div>
        </div>
        <div className="account-area">
          <div className="avatar" aria-hidden="true">{user?.username.slice(0, 1).toUpperCase()}</div>
          <div className="account-copy"><strong>{user?.username}</strong><span>{user?.role === 'admin' ? 'Administrator' : 'Family member'}</span></div>
          <button className="icon-button" aria-label="Sign out" onClick={() => void store.logout()}><LogOut size={18} /></button>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <button className="icon-button menu-button" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button>
          <label className="search-field">
            <Search size={18} aria-hidden="true" />
            <span className="sr-only">Search your library</span>
            <input placeholder="Search your library" disabled aria-label="Search your library" />
          </label>
          <button className="button button-primary upload-button" onClick={chooseUpload}><Upload size={17} /> <span>Upload</span></button>
          <input ref={pickerRef} className="sr-only" type="file" accept="image/jpeg,image/png,video/mp4,video/webm" multiple tabIndex={-1} aria-hidden="true" onChange={handlePickerChange} />
        </header>
        <div className="content-scroll"><Workspace api={api} currentUser={user!} view={view} uploadSelection={uploadSelection} onUploadSelectionConsumed={consumeUploadSelection} /></div>
      </main>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navItems.slice(0, 3).map(({ id, label, icon: Icon }) => (
          <button key={id} className={`mobile-nav-item ${view === id ? 'is-active' : ''}`} onClick={() => onViewChange(id)}><Icon size={19} /><span>{label}</span></button>
        ))}
        <button className={`mobile-nav-item ${view === 'settings' ? 'is-active' : ''}`} onClick={() => onViewChange('settings')}><Settings size={19} /><span>Settings</span></button>
      </nav>
    </div>
  );
}

function Workspace({ api, currentUser, view, uploadSelection, onUploadSelectionConsumed }: { api: ReturnType<typeof createApiClient>; currentUser: NonNullable<SessionStore['snapshot']['user']>; view: View; uploadSelection: UploadSelection | null; onUploadSelectionConsumed: (id: number) => void }) {
  if (view === 'gallery') return <GalleryWorkspace api={api} />;
  if (view === 'folders') return <FoldersWorkspace api={api} />;
  if (view === 'upload') return <UploadWorkspace api={api} selection={uploadSelection} onSelectionConsumed={onUploadSelectionConsumed} />;
  if (view === 'sharing') return <SharingWorkspace api={api} />;
  if (view === 'settings') return <SettingsWorkspace api={api} currentUser={currentUser} />;
  return null;
}

function LoadingScreen() { return <main className="loading-screen" aria-busy="true"><span className="brand-mark" aria-hidden="true">77</span><p>Opening your library…</p></main>; }

function readView(): View {
  const value = window.location.hash.replace(/^#\/?/, '') as View;
  return navItems.some((item) => item.id === value) || value === 'upload' ? value : 'gallery';
}

function writeView(view: View) {
  window.history.pushState({}, '', `#/${view}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
