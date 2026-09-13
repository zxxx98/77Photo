import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react';
import { ImageOff, LockKeyhole } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';
import { ApiError, type ApiClient, type PublicPhoto, type PublicShare } from '../../app/api';
import LanguageToggle from '../i18n/LanguageToggle';
import BrandMark from '../branding/BrandMark';
import { PublicShareSkeleton } from '../loading/LoadingStates';

export default function PublicSharePage({ api, token }: { api: ApiClient; token: string }) {
  const { t } = useI18n();
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
      setError(t('public.unavailableTitle'));
    } finally {
      setLoadingPhotos(false);
    }
  }, [api, t, token]);

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
    }).catch(() => { if (active) setError(t('public.unavailableTitle')); }).finally(() => { if (active) setLoading(false); });
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
      setError(caught instanceof ApiError && caught.code === 'SHARE_UNAVAILABLE' ? t('public.unavailableTitle') : t('public.incorrectPassword'));
    } finally {
      setLoading(false);
    }
  }

  if (loading && !share) return <PublicPageFrame><PublicShareSkeleton withHeading /></PublicPageFrame>;
  if (!share) return <PublicPageFrame><div className="public-share-state"><ImageOff size={24} /><h1>{t('public.unavailableTitle')}</h1><p>{t('public.unavailableDescription')}</p></div></PublicPageFrame>;
  if (share.password_required && !unlocked) return <PublicPageFrame><div className="public-share-gate"><span className="public-share-lock"><LockKeyhole size={21} /></span><span className="eyebrow">{t('public.privateLink')}</span><h1>{t('public.passwordRequired')}</h1><p>{t('public.enterPassword', { resource: t(share.resource_type === 'photo' ? 'common.photo' : 'common.folder') })}</p><form onSubmit={unlock}><label>{t('auth.password')}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus autoComplete="current-password" /></label>{error && <p className="form-message" role="alert">{error}</p>}<button className="button button-primary" type="submit" disabled={loading || !password}>{loading ? t('public.checking') : t('public.viewSharedMemories')}</button></form></div></PublicPageFrame>;

  return <PublicPageFrame>
    <section className="public-share-content" aria-labelledby="public-share-title">
      <div className="public-share-heading"><div><span className="eyebrow">{t('public.sharedResource', { resource: t(share.resource_type === 'photo' ? 'common.photo' : 'common.folder') })}</span><h1 id="public-share-title">{share.name}</h1>{share.folder_path && <p>{share.folder_path}</p>}</div><span className="public-share-readonly">{t('public.viewOnly')}</span></div>
      {error && <p className="form-message" role="alert">{error}</p>}
      {loadingPhotos ? <PublicShareSkeleton /> : photos.length === 0 ? <div className="public-share-empty"><ImageOff size={24} /><p>{t('public.noPhotos')}</p></div> : <div className="public-photo-grid">{photos.map((photo) => <PublicPhotoTile key={photo.id} api={api} token={token} photo={photo} />)}</div>}
    </section>
  </PublicPageFrame>;
}

function PublicPageFrame({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return <main className="public-share-page"><div className="public-share-top"><div className="public-share-brand"><BrandMark /><span>77Photo</span></div><LanguageToggle /></div>{children}<p className="public-share-footer">{t('public.footer')}</p></main>;
}

function PublicPhotoTile({ api, token, photo }: { api: ApiClient; token: string; photo: PublicPhoto }) {
  const [failed, setFailed] = useState(false);
  const preview = api.publicSharePreviewURL(token, photo.id);
  return <figure className="public-photo-tile"><div className={`public-photo-frame ${failed ? 'is-failed' : ''}`}>{failed ? <ImageOff size={22} /> : photo.mime_type.startsWith('video/') ? <video src={preview} controls controlsList="nodownload" onError={() => setFailed(true)} /> : <img src={preview} alt={photo.filename} loading="lazy" onError={() => setFailed(true)} />}</div><figcaption>{photo.filename}</figcaption></figure>;
}
