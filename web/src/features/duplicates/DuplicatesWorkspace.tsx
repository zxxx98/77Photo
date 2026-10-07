import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type ApiClient, type Photo, type User } from '../../app/api';
import { useI18n } from '../../app/I18nProvider';
import Viewer from '../viewer/Viewer';
import { duplicateStrings } from './strings';
import type { DuplicateGroup, DuplicateJob, DuplicateKind } from './types';
import './DuplicatesWorkspace.css';

export default function DuplicatesWorkspace({ api, currentUser }: { api: ApiClient; currentUser: User }) {
  const { locale } = useI18n(); const s = duplicateStrings(locale); const duplicates = api.duplicates;
  const [kind, setKind] = useState<DuplicateKind>('exact');
  const [groups, setGroups] = useState<DuplicateGroup[]>([]); const [next, setNext] = useState('');
  const [ai, setAI] = useState(false); const [job, setJob] = useState<DuplicateJob>();
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(''); const [skipped, setSkipped] = useState(false);
  const [preferred, setPreferred] = useState(''); const [photo, setPhoto] = useState<Photo>();
  const generation = useRef(0); const tab = useRef(kind); tab.current = kind;
  const error = useCallback((e: unknown) => {
    setMessage(e instanceof ApiError && e.code === 'DUPLICATE_GROUP_CHANGED' ? s.changed : e instanceof ApiError && e.code === 'MAINTENANCE_IN_PROGRESS' ? s.busy : s.error);
  }, [s.changed, s.busy, s.error]);
  const reload = useCallback(async (signal?: AbortSignal) => {
    if (!duplicates || currentUser.role !== 'admin') return;
    const sequence = ++generation.current; const view = tab.current; setLoading(true);
    try { const page = await duplicates.groups(view, '', signal); if (sequence === generation.current && !signal?.aborted) { setGroups(page.items); setNext(page.next_cursor); setSkipped(page.skipped > 0); } }
    finally { if (sequence === generation.current && !signal?.aborted) setLoading(false); }
  }, [duplicates, currentUser.role]);
  useEffect(() => {
    const controller = new AbortController(); setGroups([]); setNext(''); setMessage('');
    void reload(controller.signal).catch(e => { if (!controller.signal.aborted) error(e); });
    return () => { controller.abort(); generation.current++; };
  }, [kind, reload, error]);
  useEffect(() => {
    if (!duplicates || currentUser.role !== 'admin') return; let alive = true;
    void Promise.all([duplicates.config(), duplicates.jobs()]).then(([config, result]) => { if (alive) { setAI(config.ai_enabled); setJob(result.items[0]); } }).catch(e => { if (alive) error(e); });
    return () => { alive = false; };
  }, [duplicates, currentUser.role, error]);
  useEffect(() => {
    if (!duplicates || job?.status !== 'running') return; let alive = true; let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const result = await duplicates!.jobs(); if (!alive) return; const updated = result.items.find(j => j.id === job!.id); if (updated) { setJob(updated); if (updated.status === 'completed') await reload(); } }
      catch (e) { if (alive) error(e); }
      if (alive) timer = setTimeout(() => void poll(), 2000);
    }
    timer = setTimeout(() => void poll(), 1000); return () => { alive = false; clearTimeout(timer); };
  }, [duplicates, job?.id, job?.status, reload, error]);
  if (currentUser.role !== 'admin' || !duplicates) return null;
  const duplicateApi = duplicates;
  async function act(fn: () => Promise<void>) { setBusy(true); setMessage(''); try { await fn(); } catch (e) { error(e); } finally { setBusy(false); } }
  const active = job?.status === 'running' || job?.status === 'paused';
  return <section className="duplicates-workspace">
    <div className="workspace-heading"><div><h1>{s.title}</h1><p>{s.description}</p></div><button className="button button-secondary" disabled={busy || loading} onClick={() => void act(() => reload())}>{s.refresh}</button></div>
    <div className="duplicate-scan-panel">
      <p>{s.scanNote}</p><div className="duplicate-actions">
        <button className="button button-secondary" disabled={busy || active} onClick={() => void act(async () => setJob(await duplicateApi.start('perceptual')))}>{s.scanning}</button>
        <button className="button button-secondary" disabled={busy || active || !ai} onClick={() => void act(async () => setJob(await duplicateApi.start('ai')))}>{s.scanAI}</button>
      </div>
      {!ai && <p>{s.aiDisabled} <a href="https://github.com/zxxx98/77Photo/blob/main/docs/operations/duplicates.md" target="_blank" rel="noreferrer">{s.guide}</a></p>}
      {job && <div role="status"><p>{job.status === 'running' && job.processed === job.total ? s.comparing : s[job.status]} · {job.processed}/{job.total} · {s.failedCount}: {job.failed}</p>
        {job.status === 'running' && <progress max={Math.max(1, job.total)} value={job.processed} />}
        {active && <div className="duplicate-actions"><button className="text-button" disabled={busy} onClick={() => void act(async () => setJob(await duplicateApi.control(job.id, job.status === 'running' ? 'pause' : 'resume')))}>{job.status === 'running' ? s.pause : s.resume}</button><button className="text-button" disabled={busy} onClick={() => void act(async () => setJob(await duplicateApi.control(job.id, 'cancel')))}>{s.cancel}</button></div>}
      </div>}
    </div>
    <div className="duplicate-actions" role="group" aria-label={s.title}>{(['exact', 'perceptual', 'ai'] as const).map(value => <button key={value} className={`button ${value === kind ? 'button-primary' : 'button-secondary'}`} aria-pressed={kind === value} disabled={busy} onClick={() => setKind(value)}>{s[value]}</button>)}</div>
    <label className="duplicate-preference">{s.preferred}<input value={preferred} placeholder={s.preferredHint} onChange={e => setPreferred(e.target.value)} disabled={busy} /></label>
    {message && <p role="alert">{message}</p>}{skipped && <p>{s.skipped}</p>}
    {kind !== 'exact' && <p>{s.similarNote}</p>}
    {!loading && groups.length === 0 && <p className="inline-state">{s.empty}</p>}
    {loading && <progress aria-label={s.running} />}
    {groups.map(group => <DuplicateGroupCard key={`${group.id}:${group.version}:${preferred}`} group={group} preferred={preferred} busy={busy || active} onOpen={id => void act(async () => setPhoto(await api.getPhoto(id)))} onCleanup={(keep, remove) => void act(async () => {
      const result = await duplicateApi.cleanup({ group_id: group.id, kind: group.kind, version: group.version, keep_id: keep, remove_ids: remove, confirm: true });
      setMessage(result.failed.length ? s.partial : `${s.done}: ${result.deleted_ids.length}`); await reload();
    })} />)}
    {next && <button className="button button-secondary" disabled={busy || loading} onClick={() => void act(async () => {
      const sequence = generation.current; const page = await duplicateApi.groups(kind, next);
      if (sequence === generation.current) { setGroups(v => [...v, ...page.items]); setNext(page.next_cursor); setSkipped(v => v || page.skipped > 0); }
    })}>{s.more}</button>}
    {photo && <Viewer api={api} photos={[photo]} selected={0} onClose={() => setPhoto(undefined)} onUpdated={setPhoto} onDeleted={() => { setPhoto(undefined); void reload().catch(error); }} />}
  </section>;
}

function DuplicateGroupCard({ group, preferred, busy, onOpen, onCleanup }: { group: DuplicateGroup; preferred: string; busy: boolean; onOpen: (id: string) => void; onCleanup: (keep: string, remove: string[]) => void }) {
  const { locale } = useI18n(); const s = duplicateStrings(locale);
  const path = preferred.trim().replace(/\/$/, '');
  const suggested = (path && group.items.find(it => it.folder_path === path || it.folder_path.startsWith(path + '/'))?.id) || group.recommended_id;
  const [keep, setKeep] = useState(suggested); const [remove, setRemove] = useState<string[]>([]); const [confirm, setConfirm] = useState(false);
  const selectedBytes = group.items.filter(it => remove.includes(it.id)).reduce((total, it) => total + it.size, 0);
  return <article className="duplicate-group">
    <div className="duplicate-group-heading"><h2>{s[group.reason]}</h2><span>{s.owner}: {group.owner_name || group.owner_id}</span>{group.kind !== 'exact' && <span>{s.similarity}: {group.score.toFixed(3)}</span>}</div>
    {group.items.some(it => it.has_favorites || it.has_shares || it.has_face_annotations) && <p className="duplicate-warning">{s.annotations}</p>}
    <div className="duplicate-grid">{group.items.map(item => <div className={`duplicate-photo ${keep === item.id ? 'is-keeper' : ''}`} key={item.id}>
      <button className="duplicate-preview" aria-label={`${s.open}: ${item.filename}`} onClick={() => onOpen(item.id)}><DuplicateThumbnail id={item.id} filename={item.filename} /></button>
      <strong>{item.filename}</strong><p className="duplicate-path">{item.folder_path}</p><span>{item.width ?? '?'} × {item.height ?? '?'} · {formatBytes(item.size)}</span>
      <div className="duplicate-badges">{item.id === suggested && <span>{s.recommend}</span>}{item.has_favorites && <span>{s.favorite}</span>}{item.has_shares && <span>{s.shared}</span>}{item.has_face_annotations && <span>{s.annotated}</span>}{item.is_live_photo && <span>{s.live}</span>}</div>
      <label><input type="radio" name={`keeper-${group.id}`} checked={keep === item.id} disabled={busy} onChange={() => { setKeep(item.id); setRemove(v => v.filter(id => id !== item.id)); setConfirm(false); }} />{s.keep}</label>
      <label><input type="checkbox" checked={remove.includes(item.id)} disabled={busy || keep === item.id} onChange={e => { setRemove(v => e.target.checked ? [...v, item.id] : v.filter(id => id !== item.id)); setConfirm(false); }} />{s.select}</label>
    </div>)}</div>
    <div className="duplicate-actions">
      {group.kind === 'exact' && <button className="text-button" disabled={busy || group.items.length > 501} onClick={() => { setRemove(group.items.filter(it => it.id !== keep).map(it => it.id)); setConfirm(false); }}>{s.selectOthers}</button>}
      <span>{s.selected}: {remove.length} {s.photos} · {s.originalBytes}: {formatBytes(selectedBytes)}</span>
      <button className="button button-secondary" disabled={busy || remove.length === 0 || remove.length > 500} onClick={() => setConfirm(true)}>{s.review}</button>
    </div>
    {confirm && <div className="duplicate-confirm" role="group" aria-label={s.review}><p>{s.warning}</p><div className="duplicate-actions"><button className="button button-danger" disabled={busy} onClick={() => onCleanup(keep, remove)}>{s.confirm}</button><button className="text-button" disabled={busy} onClick={() => setConfirm(false)}>{s.dismiss}</button></div></div>}
  </article>;
}
function DuplicateThumbnail({ id, filename }: { id: string; filename: string }) {
  const [attempt, setAttempt] = useState(0); const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!waiting || attempt >= 4) return;
    const timer = setTimeout(() => { setAttempt(v => v + 1); setWaiting(false); }, 1000);
    return () => clearTimeout(timer);
  }, [waiting, attempt]);
  return <img src={waiting && attempt >= 4 ? '/image-placeholder.svg' : `/api/v1/photos/${encodeURIComponent(id)}/thumbnail?size=512&retry=${attempt}`} alt={filename} loading="lazy" onError={() => setWaiting(true)} />;
}
function formatBytes(bytes: number) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
