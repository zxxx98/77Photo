import { FormEvent, useState } from 'react';
import { Check, Copy, Link as LinkIcon, Share2, X } from 'lucide-react';
import type { ApiClient, ShareDuration, ShareLink, ShareResourceType } from '../../app/api';
import { createCopyLinkHandler, durationDetail, durationLabel, selectShareDuration, shareCopy, shareDurations, successMessage } from './shareDialog';
import { useI18n } from '../../app/I18nProvider';

type ShareResource = { type: ShareResourceType; id: string; name: string };

export default function ShareDialog({ api, resource, onClose }: { api: ApiClient; resource: ShareResource; onClose: () => void }) {
  const { locale, t } = useI18n();
  const [duration, setDuration] = useState<ShareDuration>('forever');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<ShareLink | null>(null);
  const [copied, setCopied] = useState(false);
  const copy = shareCopy(resource.type, resource.name, locale);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.createShareLink({
        resource_type: resource.type,
        resource_id: resource.id,
        duration,
        ...(password ? { password } : {}),
      });
      setLink(created);
    } catch {
      setError(t('sharing.unableCreate'));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(new URL(link.url, window.location.href).toString());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError(t('sharing.copyFailed'));
    }
  }

  return <div className="share-dialog-scrim" role="presentation">
    <section className="share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title">
      <button className="icon-button share-dialog-close" type="button" aria-label={t('sharing.closeDialog')} onClick={onClose}><X size={19} /></button>
      <div className="share-dialog-heading">
        <span className="share-dialog-icon"><Share2 size={19} /></span>
        <div><span className="eyebrow">{t('sharing.publicLink')}</span><h2 id="share-dialog-title">{copy.title}</h2></div>
      </div>
      <p className="share-dialog-name" title={resource.name}>{resource.name}</p>
      {!link ? <form className="share-dialog-form" onSubmit={create}>
        <p className="share-dialog-note">{t('sharing.anyoneCanView')}</p>
        <fieldset className="share-duration-fieldset" aria-describedby="share-duration-help">
          <legend>{t('sharing.linkDuration')}</legend>
          <p className="share-duration-help" id="share-duration-help">{t('sharing.durationHelp')}</p>
          <div className="share-duration-list">
            {shareDurations.map((option) => <label className={`share-duration-option ${duration === option.value ? 'is-selected' : ''}`} key={option.value}>
              <input type="radio" name="share-duration" value={option.value} checked={duration === option.value} onChange={() => setDuration(selectShareDuration(duration, option.value))} />
              <span className="share-duration-copy"><span className="share-duration-label">{durationLabel(option.value, locale)}</span><span className="share-duration-detail">{durationDetail(option.value, locale)}</span></span>
            </label>)}
          </div>
        </fieldset>
        <label className="share-password-field">{t('sharing.optionalPassword')}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t('sharing.noPassword')} autoComplete="new-password" /></label>
        {error && <p className="form-message" role="alert">{error}</p>}
        <button className="button button-primary share-submit" type="submit" disabled={busy}>{busy ? t('sharing.creatingLink') : copy.createLabel}</button>
      </form> : <div className="share-dialog-success">
        <p className="share-success-message" role="status">{successMessage(resource.type, duration, locale)}</p>
        <label className="share-url-field">{t('sharing.shareLink')}<input value={link.url} readOnly aria-label={t('sharing.shareLink')} /></label>
        <button className="button button-secondary share-copy-button" type="button" onClick={createCopyLinkHandler(copyLink)}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? t('sharing.copied') : t('sharing.copyLink')}</button>
        {error && <p className="form-message" role="alert">{error}</p>}
        <p className="share-dialog-note">{t('sharing.keepLinkPrivate')}</p>
      </div>}
      <span className="sr-only"><LinkIcon /></span>
    </section>
  </div>;
}
