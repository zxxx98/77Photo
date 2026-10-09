import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type ApiClient, type Photo, type User } from '../../app/api';
import { useI18n } from '../../app/I18nProvider';
import Viewer from '../viewer/Viewer';
import { duplicateStrings } from './strings';
import type { DuplicateGroup, DuplicateJob, DuplicateKind } from './types';
import './DuplicatesWorkspace.css';

function photoLabel(photo: { folder_path: string; filename: string }) { return `${photo.folder_path}/${photo.filename}`; }

type Selection = { keep: string; remove: string[] };
function suggestedKeeper(group: DuplicateGroup, preferred: string) {
  const path = preferred.trim().replace(/\/$/, '');
  return (path && group.items.find(it => it.folder_path === path || it.folder_path.startsWith(path + '/'))?.id) || group.recommended_id;
}

export default function DuplicatesWorkspace({ api, currentUser }: { api: ApiClient; currentUser: User }) {
  const { locale } = useI18n(); const s = duplicateStrings(locale); const duplicates = api.duplicates;
  const [kind, setKind] = useState<DuplicateKind>('exact');
  const [groups, setGroups] = useState<DuplicateGroup[]>([]); const [next, setNext] = useState('');
  const [ai, setAI] = useState(false); const [job, setJob] = useState<DuplicateJob>();
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(''); const [skipped, setSkipped] = useState(false);
  const [preferred, setPreferred] = useState(''); const [photo, setPhoto] = useState<Photo>();
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [reviewBatch, setReviewBatch] = useState(false);
  const generation = useRef(0); const tab = useRef(kind); tab.current = kind;
  const error = useCallback((e: unknown) => {
    setMessage(e instanceof ApiError && e.code === 'DUPLICATE_GROUP_CHANGED' ? s.changed : e instanceof ApiError && e.code === 'MAINTENANCE_IN_PROGRESS' ? s.busy : s.error);
  }, [s.changed, s.busy, s.error]);
  const reload = useCallback(async (signal?: AbortSignal) => {
    if (!duplicates || currentUser.role !== 'admin') return;
    const sequence = ++generation.current; const view = tab.current; setLoading(true);
    try { const page = await duplicates.groups(view, '', signal); if (sequence === generation.current && !signal?.aborted) { setSelections({}); setReviewBatch(false); setGroups(page.items); setNext(page.next_cursor); setSkipped(page.skipped > 0); } }
    finally { if (sequence === generation.current && !signal?.aborted) setLoading(false); }
  }, [duplicates, currentUser.role]);
  useEffect(() => {
    const controller = new AbortController(); setSelections({}); setReviewBatch(false); setGroups([]); setNext(''); setMessage('');
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
  const selectionFor = (group: DuplicateGroup): Selection => selections[group.id] ?? { keep: suggestedKeeper(group, preferred), remove: [] };
  const selected = groups.map(group => ({ group, ...selectionFor(group) })).filter(item => item.remove.length > 0);
  const keepIDs = new Set(selected.map(item => item.keep));
  const removeIDs = selected.flatMap(item => item.remove);
  const conflict = removeIDs.some(id => keepIDs.has(id)) || new Set(removeIDs).size !== removeIDs.length;
  const invalid = conflict || selected.some(item => item.remove.length > 500);
  const selectedBytes = selected.reduce((sum, item) => sum + item.group.items.filter(photo => item.remove.includes(photo.id)).reduce((bytes, photo) => bytes + photo.size, 0), 0);
  function selectLoaded() {
    const result: Record<string, Selection> = {};
    const kept = new Set<string>(); const removed = new Set<string>(); let skipped = 0;
    for (const group of groups) {
      const keep = selectionFor(group).keep;
      const remove = group.items.filter(item => item.id !== keep).map(item => item.id);
      // Similarity groups are pairs, and can overlap. Never delete another selected group's keeper
      // or submit the same deletion twice (which would invalidate the later group's version).
      if (remove.length > 500 || removed.has(keep) || remove.some(id => kept.has(id) || removed.has(id))) {
        result[group.id] = { keep, remove: [] }; skipped++; continue;
      }
      result[group.id] = { keep, remove }; kept.add(keep); remove.forEach(id => removed.add(id));
    }
    setSelections(result); setReviewBatch(false); setMessage(skipped ? `${s.batchSkipped}: ${skipped}` : '');
  }
  async function cleanupBatch() {
    if (!selected.length || invalid) return;
    let deleted = 0; let incomplete = false; let failure: unknown;
    for (const item of selected) {
      try {
        const result = await duplicateApi.cleanup({ group_id: item.group.id, kind: item.group.kind, version: item.group.version, keep_id: item.keep, remove_ids: item.remove, confirm: true });
        deleted += result.deleted_ids.length;
        if (result.failed.length) { incomplete = true; break; }
      } catch (e) { incomplete = true; failure = e; break; }
    }
    setSelections({}); setReviewBatch(false);
    try { await reload(); } catch (e) { incomplete = true; failure ??= e; }
    const reason = failure instanceof ApiError && failure.code === 'DUPLICATE_GROUP_CHANGED' ? s.changed : failure instanceof ApiError && failure.code === 'MAINTENANCE_IN_PROGRESS' ? s.busy : failure ? s.error : '';
    setMessage(`${s.done}: ${deleted}${incomplete ? ` · ${s.batchStopped} ${reason}` : ''}`);
  }

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
    <label className="duplicate-preference">{s.preferred}<input value={preferred} placeholder={s.preferredHint} onChange={e => { setPreferred(e.target.value); setSelections({}); setReviewBatch(false); }} disabled={busy || reviewBatch} /></label>
    {message && <p role="alert">{message}</p>}{skipped && <p>{s.skipped}</p>}
    {kind !== 'exact' && <p>{s.similarNote}</p>}
    {!loading && groups.length === 0 && <p className="inline-state">{s.empty}</p>}
    {loading && <progress aria-label={s.running} />}
    {groups.length > 0 && <div className="duplicate-batch">
      <p>{s.batchScope}</p>
      <div className="duplicate-actions">
        <button className="button button-secondary" disabled={busy || loading || active} onClick={selectLoaded}>{s.selectLoaded}</button>
        <button className="text-button" disabled={busy || !selected.length} onClick={() => { setSelections({}); setReviewBatch(false); }}>{s.clearSelection}</button>
        <span>{s.selected}: {selected.length} {s.groups} · {new Set(removeIDs).size} {s.photos} · {s.originalBytes}: {formatBytes(selectedBytes)}</span>
        <button className="button button-primary" disabled={busy || loading || active || !selected.length || invalid} onClick={() => setReviewBatch(true)}>{s.reviewBatch}</button>
      </div>
      {conflict && <p role="alert">{s.selectionConflict}</p>}
      {reviewBatch && <div className="duplicate-confirm" role="group" aria-label={s.reviewBatch}>
        <p>{s.warning}</p>{kind !== 'exact' && <p>{s.similarNote}</p>}
        {selected.some(item => item.group.items.some(photo => photo.has_favorites || photo.has_shares || photo.has_face_annotations)) && <p>{s.annotations}</p>}
        <ul>{selected.map(item => <li key={item.group.id}>
          {s.owner}: {item.group.owner_name || item.group.owner_id} · {s.keep}: {item.group.items.filter(photo => photo.id === item.keep).map(photoLabel).join(', ')} · {s.remove}: {item.group.items.filter(photo => item.remove.includes(photo.id)).map(photoLabel).join(', ')}
        </li>)}</ul>
        <div className="duplicate-actions"><button className="button button-danger" disabled={busy || loading || active || invalid} onClick={() => void act(cleanupBatch)}>{s.confirmBatch}</button><button className="text-button" disabled={busy} onClick={() => setReviewBatch(false)}>{s.dismiss}</button></div>
      </div>}
    </div>}
    {groups.map(group => <DuplicateGroupCard key={`${group.id}:${group.version}:${preferred}`} group={group} preferred={preferred} selection={selectionFor(group)} onSelection={value => { setSelections(previous => ({ ...previous, [group.id]: value })); setReviewBatch(false); }} busy={busy || loading || active} onOpen={id => void act(async () => setPhoto(await api.getPhoto(id)))} onCleanup={(keep, remove) => void act(async () => {
      const result = await duplicateApi.cleanup({ group_id: group.id, kind: group.kind, version: group.version, keep_id: keep, remove_ids: remove, confirm: true });
      setMessage(result.failed.length ? s.partial : `${s.done}: ${result.deleted_ids.length}`); await reload();
    })} />)}
    {next && <button className="button button-secondary" disabled={busy || loading} onClick={() => void act(async () => {
      const sequence = generation.current; const page = await duplicateApi.groups(kind, next);
      if (sequence === generation.current) { setReviewBatch(false); setGroups(v => [...v, ...page.items]); setNext(page.next_cursor); setSkipped(v => v || page.skipped > 0); }
    })}>{s.more}</button>}
    {photo && <Viewer api={api} photos={[photo]} selected={0} onClose={() => setPhoto(undefined)} onUpdated={setPhoto} onDeleted={() => { setPhoto(undefined); void reload().catch(error); }} />}
  </section>;
}

function DuplicateGroupCard({ group, preferred, selection, onSelection, busy, onOpen, onCleanup }: { group: DuplicateGroup; preferred: string; selection: Selection; onSelection: (value: Selection) => void; busy: boolean; onOpen: (id: string) => void; onCleanup: (keep: string, remove: string[]) => void }) {
  const { locale } = useI18n(); const s = duplicateStrings(locale);
  const suggested = suggestedKeeper(group, preferred);
  const { keep, remove } = selection;
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setConfirm(false), [selection]);
  const selectedBytes = group.items.filter(it => remove.includes(it.id)).reduce((total, it) => total + it.size, 0);
  return <article className="duplicate-group">
    <div className="duplicate-group-heading"><h2>{s[group.reason]}</h2><span>{s.owner}: {group.owner_name || group.owner_id}</span>{group.kind !== 'exact' && <span>{s.similarity}: {group.score.toFixed(3)}</span>}</div>
    {group.items.some(it => it.has_favorites || it.has_shares || it.has_face_annotations) && <p className="duplicate-warning">{s.annotations}</p>}
    <div className="duplicate-grid">{group.items.map(item => <div className={`duplicate-photo ${keep === item.id ? 'is-keeper' : ''}`} key={item.id}>
      <button className="duplicate-preview" disabled={busy} aria-label={`${s.open}: ${item.filename}`} onClick={() => onOpen(item.id)}><DuplicateThumbnail id={item.id} filename={item.filename} /></button>
      <strong>{item.filename}</strong><p className="duplicate-path">{item.folder_path}</p><span>{item.width ?? '?'} × {item.height ?? '?'} · {formatBytes(item.size)}</span>
      <div className="duplicate-badges">{item.id === suggested && <span>{s.recommend}</span>}{item.has_favorites && <span>{s.favorite}</span>}{item.has_shares && <span>{s.shared}</span>}{item.has_face_annotations && <span>{s.annotated}</span>}{item.is_live_photo && <span>{s.live}</span>}</div>
      <label><input type="radio" name={`keeper-${group.id}`} checked={keep === item.id} disabled={busy} onChange={() => { onSelection({ keep: item.id, remove: remove.filter(id => id !== item.id) }); setConfirm(false); }} />{s.keep}</label>
      <label><input type="checkbox" checked={remove.includes(item.id)} disabled={busy || keep === item.id} onChange={e => { onSelection({ keep, remove: e.target.checked ? [...remove, item.id] : remove.filter(id => id !== item.id) }); setConfirm(false); }} />{s.select}</label>
    </div>)}</div>
    <div className="duplicate-actions">
      <button className="text-button" disabled={busy || group.items.length > 501} onClick={() => { onSelection({ keep, remove: group.items.filter(it => it.id !== keep).map(it => it.id) }); setConfirm(false); }}>{s.selectOthers}</button>
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
