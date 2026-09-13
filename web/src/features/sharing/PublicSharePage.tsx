import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react';
import { ImageOff, LoaderCircle, LockKeyhole } from 'lucide-react';
import { ApiError, type ApiClient, type PublicPhoto, type PublicShare } from '../../app/api';

export default function PublicSharePage({ api, token }: { api: ApiClient; token: string }) {
  const [share, setShare] = useState<PublicShare | null>(null);
  const [photos, setPhotos] = useState<PublicPhoto[]>([]);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingPhotos, setLoadingPhotos] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPhotos = useCallback(async () => {
    setLoadingPhotos(true);
    try {
      const response = await api.listPublicSharePhotos(token);
      setPhotos(response.items);
      setError(null);
    } catch {
      setError('This shared item is unavailable.');
    } finally {
      setLoadingPhotos(false);
    }
  }, [api, token]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setShare(null);
    setPhotos([]);
    setUnlocked(false);
    void api.getPublicShare(token).then((response) => {
      if (!active) return;
      setShare(response);
      if (!response.password_required) void loadPhotos();
    }).catch(() => { if (active) setError('This shared item is unavailable.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, loadPhotos, token]);

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const response = await api.unlockPublicShare(token, password);
      setShare(response);
      setUnlocked(true);
      setPassword('');
      await loadPhotos();
    } catch (caught) {
      setError(caught instanceof ApiError && caught.code === 'SHARE_UNAVAILABLE' ? 'This shared item is unavailable.' : 'The password is incorrect.');
    } finally {
      setLoading(false);
    }
  }

  if (loading && !share) return <PublicPageFrame><div className="public-share-state"><LoaderCircle className="spin" size={21} /><p>Opening shared memories…</p></div></PublicPageFrame>;
  if (!share) return <PublicPageFrame><div className="public-share-state"><ImageOff size={24} /><h1>This shared item is unavailable.</h1><p>The link may have expired or been removed.</p></div></PublicPageFrame>;
  if (share.password_required && !unlocked) return <PublicPageFrame><div className="public-share-gate"><span className="public-share-lock"><LockKeyhole size={21} /></span><span className="eyebrow">Private link</span><h1>Password required</h1><p>Enter the password to view this {share.resource_type}.</p><form onSubmit={unlock}><label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus autoComplete="current-password" /></label>{error && <p className="form-message" role="alert">{error}</p>}<button className="button button-primary" type="submit" disabled={loading || !password}>{loading ? 'Checking…' : 'View shared memories'}</button></form></div></PublicPageFrame>;

  return <PublicPageFrame>
    <section className="public-share-content" aria-labelledby="public-share-title">
      <div className="public-share-heading"><div><span className="eyebrow">Shared {share.resource_type}</span><h1 id="public-share-title">{share.name}</h1>{share.folder_path && <p>{share.folder_path}</p>}</div><span className="public-share-readonly">View only</span></div>
      {error && <p className="form-message" role="alert">{error}</p>}
      {loadingPhotos ? <div className="public-share-state"><LoaderCircle className="spin" size={21} /><p>Loading memories…</p></div> : photos.length === 0 ? <div className="public-share-empty"><ImageOff size={24} /><p>No photos in this shared item.</p></div> : <div className="public-photo-grid">{photos.map((photo) => <PublicPhotoTile key={photo.id} api={api} token={token} photo={photo} />)}</div>}
    </section>
  </PublicPageFrame>;
}

function PublicPageFrame({ children }: { children: ReactNode }) {
  return <main className="public-share-page"><div className="public-share-brand"><span className="brand-mark" aria-hidden="true">77</span><span>77Photo</span></div>{children}<p className="public-share-footer">Shared from a private 77Photo library</p></main>;
}

function PublicPhotoTile({ api, token, photo }: { api: ApiClient; token: string; photo: PublicPhoto }) {
  const [failed, setFailed] = useState(false);
  const preview = api.publicSharePreviewURL(token, photo.id);
  return <figure className="public-photo-tile"><div className={`public-photo-frame ${failed ? 'is-failed' : ''}`}>{failed ? <ImageOff size={22} /> : photo.mime_type.startsWith('video/') ? <video src={preview} controls controlsList="nodownload" onError={() => setFailed(true)} /> : <img src={preview} alt={photo.filename} loading="lazy" onError={() => setFailed(true)} />}</div><figcaption>{photo.filename}</figcaption></figure>;
}
