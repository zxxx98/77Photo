import { useCallback, useEffect, useState } from 'react';
import type { ApiClient, Photo, User } from '../../app/api';
import { useI18n } from '../../app/I18nProvider';
import Viewer from '../viewer/Viewer';
import FaceScanPanel from './FaceScanPanel';
import { faceThumbnail, type Face, type Person, type SimilarPerson } from './types';
import { faceStrings } from './strings';
import './PeopleWorkspace.css';

export default function PeopleWorkspace({ api, currentUser }: { api: ApiClient; currentUser: User }) {
  const { locale } = useI18n(); const s = faceStrings(locale); const faces = api.faces;
  const [people, setPeople] = useState<Person[]>([]); const [next, setNext] = useState('');
  const [selected, setSelected] = useState<string>(''); const [items, setItems] = useState<Face[]>([]); const [faceNext, setFaceNext] = useState('');
  const [suggestions, setSuggestions] = useState<SimilarPerson[]>([]);
  const [name, setName] = useState(''); const [target, setTarget] = useState(''); const [confirmMerge, setConfirmMerge] = useState(false);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [photo, setPhoto] = useState<Photo>();
  const [owner, setOwner] = useState('');
  const person = people.find(p => p.id === selected);
  const reload = useCallback(async () => {
    if (!faces || currentUser.role !== 'admin') return;
    const page = await faces.people(); setPeople(page.items); setNext(page.next_cursor);
  }, [faces, currentUser.role]);
  useEffect(() => { void reload().catch(() => setMessage(s.error)); }, [reload, s.error]);
  useEffect(() => {
    let alive = true; setItems([]); setFaceNext(''); setSuggestions([]); setTarget(''); setConfirmMerge(false); setName(person?.name ?? '');
    if (selected && faces && currentUser.role === 'admin') {
      void faces.listFaces(selected).then(page => { if (alive) { setItems(page.items); setFaceNext(page.next_cursor); } }).catch(() => { if (alive) setMessage(s.error); });
      if (selected !== 'unassigned') void faces.similarPeople(selected).then(result => { if (alive) setSuggestions(result.items); }).catch(() => { if (alive) setMessage(s.error); });
    }
    return () => { alive = false; };
  }, [selected, faces, currentUser.role, s.error]);
  if (currentUser.role !== 'admin' || !faces) return null;
  const faceApi = faces;
  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setMessage('');
    try { await fn(); } catch { setMessage(s.error); } finally { setBusy(false); }
  }
  async function updateFace(face: Face, to: string, ignored: boolean) {
    await faceApi.assign(face, to, ignored);
    const page = await faceApi.listFaces(selected); setItems(page.items); setFaceNext(page.next_cursor); await reload();
  }
  const label = (p: Person) => p.name || `${s.unnamed} · ${p.id.slice(-6)}`;
  const targets = [...people, ...suggestions.map(item => item.person).filter(p => !people.some(existing => existing.id === p.id))];
  return <section className="people-workspace">
    <div className="workspace-heading"><div><h1>{s.title}</h1><p>{s.description}</p></div></div>
    <FaceScanPanel api={faces} onCompleted={reload} />
    {message && <p role="alert">{message}</p>}
    {!selected ? <>
      <div className="face-actions">
        <button className="button button-secondary" disabled={busy} onClick={() => void act(reload)}>{s.refresh}</button>
        <button className="button button-secondary" onClick={() => setSelected('unassigned')}>{s.unassigned}</button>
        <select aria-label={s.owner} value={owner} onChange={e => setOwner(e.target.value)}><option value="">{s.allOwners}</option>{[...new Set(people.map(p => p.owner_id))].map(id => <option key={id} value={id}>{id}</option>)}</select>
      </div>
      {people.length === 0 && <p className="inline-state">{s.empty}</p>}
      <div className="people-grid">{people.filter(p => !owner || p.owner_id === owner).map(p => <button className="person-card" key={p.id} onClick={() => { setName(p.name); setSelected(p.id); }}>
        <img src={faceThumbnail(p.cover_face_id)} alt="" loading="lazy" /><strong>{label(p)}</strong><span>{p.photo_count} {s.count}</span>
      </button>)}</div>
      {next && <button className="button button-secondary" disabled={busy} onClick={() => void act(async () => { const page = await faceApi.people(next); setPeople(p => [...p, ...page.items]); setNext(page.next_cursor); })}>{s.more}</button>}
    </> : <>
      <button className="text-button" onClick={() => setSelected('')}>{s.back}</button>
      <h2>{person ? label(person) : s.unassigned}</h2>
      {person && <div className="person-tools">
        <form className="face-actions" onSubmit={e => { e.preventDefault(); void act(async () => { await faceApi.rename(person, name); await reload(); }); }}>
          <input aria-label={s.name} maxLength={80} value={name} onChange={e => setName(e.target.value)} /><button className="button button-secondary" disabled={busy}>{s.save}</button>
        </form>
        <div className="face-actions"><select aria-label={s.target} value={target} onChange={e => { setTarget(e.target.value); setConfirmMerge(false); }}><option value="">{s.target}</option>{targets.filter(p => p.id !== selected && p.owner_id === person.owner_id).map(p => <option key={p.id} value={p.id}>{label(p)}</option>)}</select>
          <button className="button button-secondary" disabled={busy || !target} onClick={() => setConfirmMerge(true)}>{s.merge}</button>
          {next && <button className="text-button" disabled={busy} onClick={() => void act(async () => { const page = await faceApi.people(next); setPeople(p => [...p, ...page.items]); setNext(page.next_cursor); })}>{s.more}</button>}
        </div>
        {confirmMerge && <div role="group" aria-label={s.confirm}><p>{s.mergeWarning}</p><button className="button button-secondary" disabled={busy} onClick={() => void act(async () => { const to = targets.find(p => p.id === target); if (!to) return; await faceApi.merge(to, person); setSelected(''); await reload(); })}>{s.confirm}</button><button className="text-button" onClick={() => setConfirmMerge(false)}>{s.dismiss}</button></div>}
        {suggestions.length > 0 && <section aria-label={s.similar}><h3>{s.similar}</h3><p className="inline-state">{s.reviewSimilar}</p><div className="people-grid">{suggestions.map(({ person: candidate, score }) => <button className="person-card" key={candidate.id} onClick={() => { setTarget(candidate.id); setConfirmMerge(true); }}><img src={faceThumbnail(candidate.cover_face_id)} alt="" loading="lazy" /><strong>{label(candidate)}</strong><span>{s.similarity}: {score.toFixed(2)}</span></button>)}</div></section>}
      </div>}
      {items.length === 0 && <p className="inline-state">{s.noFaces}</p>}
      <div className="people-grid">{items.map(face => <article className="face-card" key={face.id}>
        <button className="face-photo-button" aria-label={`${s.open}: ${face.filename}`} onClick={() => void act(async () => setPhoto(await api.getPhoto(face.photo_id)))}><img src={faceThumbnail(face.id)} alt="" loading="lazy" /><span>{face.filename}</span></button>
        <FaceActions face={face} people={people.filter(p => p.owner_id === face.owner_id)} busy={busy} onAssign={(to, ignored) => void act(() => updateFace(face, to, ignored))} />
      </article>)}</div>
      {faceNext && <button className="button button-secondary" disabled={busy} onClick={() => void act(async () => { const page = await faceApi.listFaces(selected, faceNext); setItems(v => [...v, ...page.items]); setFaceNext(page.next_cursor); })}>{s.more}</button>}
    </>}
    {photo && <Viewer api={api} photos={[photo]} selected={0} onClose={() => setPhoto(undefined)} onUpdated={setPhoto} onDeleted={() => { setPhoto(undefined); setSelected(''); void reload(); }} />}
  </section>;
}
function FaceActions({ face, people, busy, onAssign }: { face: Face; people: Person[]; busy: boolean; onAssign: (person: string, ignored: boolean) => void }) {
  const { locale } = useI18n(); const s = faceStrings(locale); const [target, setTarget] = useState('');
  return <div className="face-card-actions">
    <select aria-label={s.target} value={target} onChange={e => setTarget(e.target.value)}><option value="">{s.newPerson}</option>{people.filter(p => p.id !== face.person_id).map(p => <option key={p.id} value={p.id}>{p.name || `${s.unnamed} · ${p.id.slice(-6)}`}</option>)}</select>
    <button className="text-button" disabled={busy} onClick={() => onAssign(target, false)}>{s.move}</button>
    <button className="text-button" disabled={busy} onClick={() => onAssign(face.person_id, !face.ignored)}>{face.ignored ? s.restore : s.ignore}</button>
  </div>;
}
