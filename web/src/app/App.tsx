import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Folder, Image, LogOut, Menu, Search, Settings, Share2, Upload, X } from 'lucide-react';
import { createApiClient } from './api';
import { SessionStore } from './auth';
import LoginPage from '../features/auth/LoginPage';
import GalleryWorkspace from '../features/gallery/GalleryWorkspace';
import FoldersWorkspace from '../features/folders/FoldersWorkspace';
import UploadWorkspace from '../features/upload/UploadWorkspace';

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
  const user = store.snapshot.user;
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
          <button className="button button-primary upload-button" onClick={() => onViewChange('upload')}><Upload size={17} /> <span>Upload</span></button>
        </header>
        <div className="content-scroll"><Workspace api={api} view={view} /></div>
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

function Workspace({ api, view }: { api: ReturnType<typeof createApiClient>; view: View }) {
  if (view === 'gallery') return <GalleryWorkspace api={api} />;
  if (view === 'folders') return <FoldersWorkspace api={api} />;
  if (view === 'upload') return <UploadWorkspace api={api} />;
  const labels: Record<Exclude<View, 'gallery'>, { title: string; detail: string }> = {
    folders: { title: 'Folders', detail: 'Your folders will appear here as you add memories.' },
    sharing: { title: 'Sharing', detail: 'Shared family folders stay visible only to invited members.' },
    settings: { title: 'Settings', detail: 'Account and library settings are kept simple and private.' },
    upload: { title: 'Upload', detail: 'Choose a folder to start adding photos to your library.' },
  };
  const copy = labels[view];
  return <section className="empty-workspace" aria-labelledby="workspace-title"><span className="eyebrow">77Photo</span><h1 id="workspace-title">{copy.title}</h1><p>{copy.detail}</p><button className="button button-secondary" onClick={() => window.history.back()}>Back to gallery</button></section>;
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
