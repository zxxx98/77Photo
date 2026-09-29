import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react';
import { ApiError, type ApiClient, type Folder, type TrashBatchResult, type TrashItem, type User } from '../../app/api';
import { useI18n } from '../../app/I18nProvider';
import { trashStrings } from './strings';
import './TrashWorkspace.css';

export default function TrashWorkspace({ api, currentUser }: { api: ApiClient; currentUser: User }) {
  const { locale, formatDate, formatCount } = useI18n();
  const s = trashStrings[locale];
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [items, setItems] = useState<TrashItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [retention, setRetention] = useState(30);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [failed, setFailed] = useState<Array<{ id: string; code: string }>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<'restore' | 'purge' | 'clear' | null>(null);
  const [rename, setRename] = useState(false);
  const [target, setTarget] = useState<Folder | null>(null);
  const [choosing, setChoosing] = useState(false);
  const generation = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (next?: string) => {
    const request = ++generation.current;
    setLoading(true); setError('');
    try {
      const page = await api.listTrash({ scope, cursor: next });
      if (request !== generation.current) return;
      setItems(old => next ? [...old, ...page.items] : page.items);
      setCursor(page.next_cursor); setRetention(page.retention_days);
      if (!next) setSelected(new Set());
    } catch { if (request === generation.current) setError(s.loadError); }
    finally { if (request === generation.current) setLoading(false); }
  }, [api, scope, s.loadError]);
  useEffect(() => { setItems([]); setCursor(null); setSelected(new Set()); setFailed([]); setNotice(''); void load(); return () => { generation.current++; }; }, [load]);
  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>('button, input, select')?.focus();
    return () => previous?.focus();
  }, [dialog]);

  const chosen = items.filter(item => selected.has(item.id));
  const owners = new Set(chosen.map(item => item.owner_id));
  const canChooseTarget = owners.size === 1;
  function errorText(code: string) {
    if (code === 'NAME_CONFLICT') return s.conflict;
    if (code === 'WRITE_FORBIDDEN' || code === 'READ_FORBIDDEN') return s.forbidden;
    if (code === 'NOT_FOUND') return s.missing;
    if (code === 'MAINTENANCE_IN_PROGRESS') return s.maintenance;
    if (code === 'TRASH_RECOVERY_REQUIRED') return s.pending;
    if (code === 'SOURCE_CHANGED') return s.changed;
    return s.error;
  }
  function openDialog(value: 'restore' | 'purge' | 'clear') { setRename(false); setTarget(null); setChoosing(false); setDialog(value); }
  async function perform() {
    if (!dialog || busy) return;
    setBusy(true); setError(''); setNotice(''); setFailed([]);
    const mode = dialog;
    try {
      const result: TrashBatchResult = { completed_ids: [], failed: [] };
      if (mode === 'restore' || mode === 'purge') {
        const ids = [...selected];
        for (let offset = 0; offset < ids.length; offset += 500) {
          const chunk = ids.slice(offset, offset + 500);
          const batch = mode === 'restore'
            ? await api.restoreTrash(chunk, { ...(target ? { folder_id: target.id } : {}), conflict: rename ? 'rename' : 'reject' })
            : await api.purgeTrash(chunk);
          result.completed_ids.push(...batch.completed_ids); result.failed.push(...batch.failed);
        }
      } else {
        const before = new Date().toISOString();
        let more = true;
        while (more) {
          const batch = await api.emptyTrash(scope, before);
          result.completed_ids.push(...batch.completed_ids); result.failed.push(...batch.failed);
          more = !!batch.has_more && batch.failed.length === 0 && batch.completed_ids.length > 0;
        }
      }
      setDialog(null);
      await load();
      setFailed(result.failed); setSelected(new Set(result.failed.map(item => item.id)));
      setNotice(result.failed.length ? s.partial.replace('{count}', formatCount(result.failed.length)) : s.completed.replace('{count}', formatCount(result.completed_ids.length)));
    } catch (e) { setError(e instanceof ApiError ? errorText(e.code) : s.error); }
    finally { setBusy(false); }
  }
  async function retry(id: string) {
    setBusy(true); setError('');
    try { await api.retryTrash(id); await load(); } catch (e) { setError(e instanceof ApiError ? errorText(e.code) : s.error); }
    finally { setBusy(false); }
  }
  function toggle(id: string) { setSelected(old => { const next = new Set(old); next.has(id) ? next.delete(id) : next.add(id); return next; }); }

  return <section className="trash-workspace" aria-labelledby="trash-title">
    <div className="workspace-heading"><div><h1 id="trash-title">{s.title}</h1><p>{s.intro}</p><p>{s.retention.replace('{days}', formatCount(retention))}</p></div>
      <div className="trash-actions"><button className="button button-secondary" disabled={busy || loading} onClick={() => void load()}><RefreshCw size={16} />{s.refresh}</button>
        <button className="button button-danger" disabled={busy || loading || !items.some(item => item.state === 'trashed')} onClick={() => openDialog('clear')}><Trash2 size={16} />{s.clear}</button></div></div>
    {currentUser.role === 'admin' && <label className="trash-scope">{s.title}<select aria-label={s.title} value={scope} disabled={busy} onChange={e => setScope(e.target.value as 'mine' | 'all')}><option value="mine">{s.mine}</option><option value="all">{s.all}</option></select></label>}
    {error && <div role="alert" className="inline-state">{error}</div>}
    {notice && <p role="status">{notice}</p>}
    {failed.length > 0 && <ul className="trash-failures">{failed.map(f => <li key={f.id}>{items.find(item => item.id === f.id)?.filename ?? f.id}: {errorText(f.code)}</li>)}</ul>}
    <div className="trash-toolbar"><button className="button button-secondary" disabled={busy || !items.length} onClick={() => setSelected(new Set(items.filter(item => item.state === 'trashed').map(item => item.id)))}>{s.selectAll}</button>
      <span>{s.selected.replace('{count}', formatCount(selected.size))}</span>
      <button className="button button-secondary" disabled={busy || !chosen.length} onClick={() => openDialog('restore')}><RotateCcw size={16} />{s.restore}</button>
      <button className="button button-danger" disabled={busy || !chosen.length} onClick={() => openDialog('purge')}><Trash2 size={16} />{s.purge}</button></div>
    {loading && <p role="status">{locale === 'zh' ? '正在加载…' : 'Loading…'}</p>}
    {!loading && !error && !items.length && <div className="inline-state">{s.empty}</div>}
    <div className="trash-grid">{items.map(item => {
      const days = Math.max(0, Math.ceil((Date.parse(item.expires_at) - Date.now()) / 86400000));
      return <article className="trash-card" key={item.id}>
        <label className="trash-select"><input type="checkbox" aria-label={`${s.select} ${item.filename}`} checked={selected.has(item.id)} disabled={busy || item.state !== 'trashed'} onChange={() => toggle(item.id)} />{item.filename}</label>
        <TrashPreview item={item} unavailable={s.preview} />
        <dl><div><dt>{s.folder}</dt><dd>{item.folder_name}</dd></div><div><dt>{s.deleted}</dt><dd>{formatDate(item.deleted_at)}</dd></div><div><dt>{s.expires}</dt><dd>{formatDate(item.expires_at)}</dd></div></dl>
        <p>{item.state === 'trashed' ? days ? s.days.replace('{days}', formatCount(days)) : s.due : item.recovery_required ? s.recovery : s.processing}</p>
        {item.state !== 'trashed' && <button className="button button-secondary" disabled={busy} onClick={() => void retry(item.id)}>{s.retry}</button>}
      </article>;
    })}</div>
    {cursor && <button className="button button-secondary" disabled={loading || busy} onClick={() => void load(cursor)}>{s.more}</button>}
    {dialog && <div className="trash-backdrop"><div ref={dialogRef} className="trash-dialog" role="dialog" aria-modal="true" aria-labelledby="trash-dialog-title" onKeyDown={event => {
      if (event.key === 'Escape' && !busy) setDialog(null);
      if (event.key === 'Tab') {
        const elements = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)') ?? [])];
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="trash-dialog-heading"><h2 id="trash-dialog-title">{dialog === 'restore' ? s.restoreTitle : dialog === 'clear' ? s.clearTitle : s.purgeTitle}</h2><button className="icon-button" aria-label={s.cancel} disabled={busy} onClick={() => setDialog(null)}><X size={20} /></button></div>
      <p>{dialog === 'restore' ? s.restoreNote : dialog === 'clear' ? s.clearWarning : s.purgeWarning}</p>
      {dialog === 'clear' && <strong>{scope === 'all' ? s.all : s.mine}</strong>}
      {dialog === 'restore' && <>
        <p>{s.destination}: {target?.name ?? s.original}</p>
        <div className="trash-actions"><button className="button button-secondary" disabled={busy} onClick={() => { setTarget(null); setChoosing(false); }}>{s.original}</button><button className="button button-secondary" disabled={busy || !canChooseTarget} onClick={() => setChoosing(true)}>{s.choose}</button></div>
        {!canChooseTarget && <p>{s.mixed}</p>}
        {choosing && canChooseTarget && <TrashFolderPicker api={api} ownerID={chosen[0].owner_id} disabled={busy} onSelect={folder => { setTarget(folder); setChoosing(false); }} />}
        <label className="trash-checkbox"><input type="checkbox" checked={rename} disabled={busy} onChange={e => setRename(e.target.checked)} />{s.rename}</label>
      </>}
      {error && <p role="alert">{error}</p>}
      <div className="trash-actions"><button className="button button-secondary" disabled={busy} onClick={() => setDialog(null)}>{s.cancel}</button><button className={`button ${dialog === 'restore' ? 'button-primary' : 'button-danger'}`} disabled={busy} onClick={() => void perform()}>{busy ? s.processing : dialog === 'restore' ? s.restore : dialog === 'clear' ? s.clear : s.purge}</button></div>
    </div></div>}
  </section>;
}

function TrashPreview({ item, unavailable }: { item: TrashItem; unavailable: string }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  if (failed || item.state !== 'trashed') return <div className="trash-preview-placeholder">{unavailable}</div>;
  return <img className="trash-preview" loading="lazy" src={`/api/v1/trash/photos/${encodeURIComponent(item.id)}/preview?attempt=${attempt}`} alt={item.filename} onError={() => {
    clearTimeout(timer.current);
    if (attempt >= 5) setFailed(true); else timer.current = setTimeout(() => setAttempt(value => value + 1), 1500);
  }} />;
}

function TrashFolderPicker({ api, ownerID, disabled, onSelect }: { api: ApiClient; ownerID: string; disabled: boolean; onSelect: (folder: Folder) => void }) {
  const { locale } = useI18n(); const s = trashStrings[locale];
  const [stack, setStack] = useState<Folder[]>([]), [folders, setFolders] = useState<Folder[]>([]);
  const [error, setError] = useState(false), [attempt, setAttempt] = useState(0), [loading, setLoading] = useState(false);
  const current = stack[stack.length - 1];
  useEffect(() => {
    let active = true; setError(false); setLoading(true); setFolders([]);
    api.listFolders(current?.id).then(page => { if (active) setFolders(page.items.filter(folder => folder.owner_id === ownerID)); }).catch(() => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, current?.id, ownerID, attempt]);
  return <div className="trash-folder-picker"><strong>{current?.name ?? s.root}</strong>
    {current && <div className="trash-actions"><button className="button button-secondary" disabled={disabled} onClick={() => setStack(old => old.slice(0, -1))}>{s.up}</button><button className="button button-secondary" disabled={disabled || loading || error} onClick={() => onSelect(current)}>{s.useFolder}</button></div>}
    {error && <p role="alert">{s.folderError}<button disabled={disabled} onClick={() => setAttempt(value => value + 1)}>{s.refresh}</button></p>}
    {folders.map(folder => <button className="trash-folder" key={folder.id} disabled={disabled} onClick={() => setStack(old => [...old, folder])}><FolderOpen size={16} />{folder.name}</button>)}
  </div>;
}
