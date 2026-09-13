import { FormEvent, useState } from 'react';
import { Check, Copy, Link as LinkIcon, Share2, X } from 'lucide-react';
import type { ApiClient, ShareDuration, ShareLink, ShareResourceType } from '../../app/api';
import { selectShareDuration, shareCopy, shareDurations, successMessage } from './shareDialog';

type ShareResource = { type: ShareResourceType; id: string; name: string };

export default function ShareDialog({ api, resource, onClose }: { api: ApiClient; resource: ShareResource; onClose: () => void }) {
  const [duration, setDuration] = useState<ShareDuration>('forever');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<ShareLink | null>(null);
  const [copied, setCopied] = useState(false);
  const copy = shareCopy(resource.type, resource.name);

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
      setError('Unable to create the share link.');
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
      setError('The link could not be copied.');
    }
  }

  return <div className="share-dialog-scrim" role="presentation">
    <section className="share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title">
      <button className="icon-button share-dialog-close" type="button" aria-label="Close share dialog" onClick={onClose}><X size={19} /></button>
      <div className="share-dialog-heading">
        <span className="share-dialog-icon"><Share2 size={19} /></span>
        <div><span className="eyebrow">Public link</span><h2 id="share-dialog-title">{copy.title}</h2></div>
      </div>
      <p className="share-dialog-name" title={resource.name}>{resource.name}</p>
      {!link ? <form className="share-dialog-form" onSubmit={create}>
        <p className="share-dialog-note">Anyone with the link can view. No account or sign-in required.</p>
        <fieldset className="share-duration-fieldset">
          <legend>Link duration</legend>
          <div className="share-duration-list">
            {shareDurations.map((option) => <label className="share-duration-option" key={option.value}>
              <input type="checkbox" checked={duration === option.value} onChange={() => setDuration(selectShareDuration(duration, option.value))} />
              <span>{option.label}</span>
            </label>)}
          </div>
        </fieldset>
        <label className="share-password-field">Optional password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Leave blank for no password" autoComplete="new-password" /></label>
        {error && <p className="form-message" role="alert">{error}</p>}
        <button className="button button-primary share-submit" type="submit" disabled={busy}>{busy ? 'Creating link…' : copy.createLabel}</button>
      </form> : <div className="share-dialog-success">
        <p className="share-success-message" role="status">{successMessage(resource.type, duration)}</p>
        <label className="share-url-field">Share link<input value={link.url} readOnly aria-label="Share link" /></label>
        <button className="button button-secondary share-copy-button" type="button" onClick={() => void copyLink}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Copied' : 'Copy link'}</button>
        {error && <p className="form-message" role="alert">{error}</p>}
        <p className="share-dialog-note">Keep this link private if it grants access to personal memories.</p>
      </div>}
      <span className="sr-only"><LinkIcon /></span>
    </section>
  </div>;
}
