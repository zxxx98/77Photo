import { FormEvent, useEffect, useState } from 'react';
import { ChevronRight, Folder, LoaderCircle, Plus, Share2 } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';
import type { ApiClient, Folder as FolderRecord } from '../../app/api';
import ShareDialog from '../sharing/ShareDialog';

export default function FoldersWorkspace({ api }: { api: ApiClient }) {
  const { t, formatCount } = useI18n();
  const [parent, setParent] = useState<FolderRecord | null>(null);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [shareResource, setShareResource] = useState<{ type: 'folder'; id: string; name: string } | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void api.listFolders(parent?.id).then((response) => { if (active) setFolders(response.items); }).catch(() => { if (active) setError(t('folders.loadFailed')); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, parent, t]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const folder = await api.createFolder(name.trim(), parent?.id ?? null);
      setFolders((current) => [...current, folder].sort((a, b) => a.name.localeCompare(b.name)));
      setName('');
    } catch { setError(t('folders.createFailed')); } finally { setCreating(false); }
  }

  return <section className="folders-workspace" aria-labelledby="folders-title"><div className="workspace-heading"><div><span className="eyebrow">{t('folders.yourLibrary')}</span><h1 id="folders-title">{t('folders.title')}</h1></div><form className="inline-create" onSubmit={create}><label className="sr-only" htmlFor="folder-name">{t('folders.newFolder')}</label><input id="folder-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={t('folders.newFolder')} /><button className="icon-button" type="submit" disabled={creating} aria-label={t('folders.createFolder')}><Plus size={19} /></button></form></div><div className="breadcrumbs"><button className="breadcrumb-button" onClick={() => setParent(null)}>{t('shell.library')}</button>{parent && <><ChevronRight size={14} /><span>{parent.name}</span></>}</div>{loading && <div className="inline-state"><LoaderCircle className="spin" size={18} /> {t('folders.loading')}</div>}{!loading && error && <p className="inline-state" role="alert">{error}</p>}{!loading && !error && folders.length === 0 && <div className="empty-timeline"><Folder size={24} /><h2>{t('folders.emptyTitle')}</h2><p>{t('folders.emptyDescription')}</p></div>}{!loading && !error && folders.length > 0 && <div className="folder-list">{folders.map((folder) => { const photoCount = folder.photo_count ?? 0; const childFolderCount = folder.child_folder_count ?? 0; return <div className="folder-row" key={folder.id}><button className="folder-row-link" type="button" onClick={() => setParent(folder)}><span className="folder-icon"><Folder size={19} /></span><span className="folder-row-copy"><strong>{folder.name}</strong><small>{photoCount === 1 ? t('folders.onePhoto', { count: formatCount(photoCount) }) : t('folders.manyPhotos', { count: formatCount(photoCount) })} · {childFolderCount === 1 ? t('folders.oneFolder', { count: formatCount(childFolderCount) }) : t('folders.manyFolders', { count: formatCount(childFolderCount) })}</small></span><ChevronRight size={18} /></button><button className="icon-button folder-share-button" type="button" aria-label={t('common.shareFolder')} title={t('common.shareFolder')} onClick={() => setShareResource({ type: 'folder', id: folder.id, name: folder.name })}><Share2 size={18} /></button></div>; })}</div>}{shareResource && <ShareDialog api={api} resource={shareResource} onClose={() => setShareResource(null)} />}</section>;
}
