import { FormEvent, useEffect, useState } from 'react';
import { ChevronRight, Folder, LoaderCircle, Plus } from 'lucide-react';
import type { ApiClient, Folder as FolderRecord } from '../../app/api';

export default function FoldersWorkspace({ api }: { api: ApiClient }) {
  const [parent, setParent] = useState<FolderRecord | null>(null);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    void api.listFolders(parent?.id).then((response) => { if (active) setFolders(response.items); }).catch(() => { if (active) setError('Unable to load folders.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, parent]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const folder = await api.createFolder(name.trim(), parent?.id ?? null);
      setFolders((current) => [...current, folder].sort((a, b) => a.name.localeCompare(b.name)));
      setName('');
    } catch { setError('Folder could not be created.'); } finally { setCreating(false); }
  }

  return <section className="folders-workspace" aria-labelledby="folders-title"><div className="workspace-heading"><div><span className="eyebrow">Your library</span><h1 id="folders-title">Folders</h1></div><form className="inline-create" onSubmit={create}><label className="sr-only" htmlFor="folder-name">New folder name</label><input id="folder-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="New folder" /><button className="icon-button" type="submit" disabled={creating} aria-label="Create folder"><Plus size={19} /></button></form></div><div className="breadcrumbs"><button className="breadcrumb-button" onClick={() => setParent(null)}>Library</button>{parent && <><ChevronRight size={14} /><span>{parent.name}</span></>}</div>{loading && <div className="inline-state"><LoaderCircle className="spin" size={18} /> Loading folders…</div>}{!loading && error && <p className="inline-state" role="alert">{error}</p>}{!loading && !error && folders.length === 0 && <div className="empty-timeline"><Folder size={24} /><h2>This folder is empty</h2><p>Create a folder to give your memories a calm home.</p></div>}{!loading && !error && folders.length > 0 && <div className="folder-list">{folders.map((folder) => <button className="folder-row" key={folder.id} onClick={() => setParent(folder)}><span className="folder-icon"><Folder size={19} /></span><span className="folder-row-copy"><strong>{folder.name}</strong><small>{folder.photo_count ?? 0} photos · {folder.child_folder_count ?? 0} folders</small></span><ChevronRight size={18} /></button>)}</div>}</section>;
}
