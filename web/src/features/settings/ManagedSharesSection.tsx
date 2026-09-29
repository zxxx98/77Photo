import { useCallback, useEffect, useRef, useState } from 'react';
import { Link2 } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';
import { readShareManagementResource } from '../../app/routes';
import type { ApiClient, ManagedShareLink, ManagedShareStatus, Photo } from '../../app/api';
import ShareDialog from '../sharing/ShareDialog';
import Viewer from '../viewer/Viewer';
import SettingsCard from './SettingsCard';
import './ManagedSharesSection.css';

const statuses: Array<ManagedShareStatus | ''> = ['', 'active', 'expired', 'revoked', 'unavailable'];

export default function ManagedSharesSection({ api, onOpenFolder }: { api: ApiClient; onOpenFolder: (folder: { id: string; name: string }) => void }) {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<ManagedShareStatus | ''>('');
  const [resource, setResource] = useState(() => readShareManagementResource(window.location.hash));
  const [items, setItems] = useState<ManagedShareLink[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ cursor?: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [message, setMessage] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busyID, setBusyID] = useState<string | null>(null);
  const [newShare, setNewShare] = useState<ManagedShareLink | null>(null);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const requestID = useRef(0);
  const resourceType = resource?.type;
  const resourceID = resource?.id;

  const load = useCallback(async (next?: string) => {
    const id = ++requestID.current;
    setLoading(true);
    setError(null);
    try {
      const page = await api.listManagedShareLinks({ ...(status ? { status } : {}), ...(next ? { cursor: next } : {}), ...(resourceType && resourceID ? { resource_type: resourceType, resource_id: resourceID } : {}) });
      if (id !== requestID.current) return;
      setItems((current) => next ? [...current, ...page.items] : page.items);
      setCursor(page.next_cursor);
    } catch {
      if (id === requestID.current) setError({ cursor: next });
    } finally {
      if (id === requestID.current) setLoading(false);
    }
  }, [api, status, resourceType, resourceID]);

  useEffect(() => {
    setItems([]);
    setCursor(undefined);
    setConfirm(null);
    void load();
    return () => { requestID.current++; };
  }, [load, refresh]);
  useEffect(() => {
    const onPopState = () => { setResource(readShareManagementResource(window.location.hash)); };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  async function revoke(id: string) {
    setBusyID(id);
    setMessage('');
    try {
      await api.revokeManagedShareLink(id);
      setConfirm(null);
      setMessage(t('settings.shares.revoked'));
      setRefresh((current) => current + 1);
    } catch {
      setMessage(t('settings.shares.revokeFailed'));
    } finally {
      setBusyID(null);
    }
  }

  async function open(item: ManagedShareLink) {
    if (item.status === 'unavailable') return;
    if (item.resource_type === 'folder') {
      onOpenFolder({ id: item.resource_id, name: item.resource_name });
      return;
    }
    setBusyID(item.id);
    setMessage('');
    try {
      setPhoto(await api.getPhoto(item.resource_id));
    } catch {
      setMessage(t('settings.shares.openFailed'));
    } finally {
      setBusyID(null);
    }
  }

  function date(value: string) { return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }

  return <SettingsCard icon={Link2} title={t('settings.shares.title')} summary={t('settings.shares.summary')}>
    <div className="managed-shares-filter">
      <label>{t('settings.shares.filter')}
        <select value={status} onChange={(event) => setStatus(event.target.value as ManagedShareStatus | '')}>
          {statuses.map((value) => <option key={value} value={value}>{t(`settings.shares.status.${value || 'all'}`)}</option>)}
        </select>
      </label>
      <button type="button" className="button button-secondary" onClick={() => void load()} disabled={loading}>{t('settings.shares.refresh')}</button>
    </div>
    {resource && <p className="managed-shares-resource-filter">{t('settings.shares.resourceFilter')} <button type="button" className="button button-secondary" onClick={() => { window.history.replaceState(window.history.state, '', '#/settings'); window.dispatchEvent(new PopStateEvent('popstate')); }}>{t('settings.shares.clearResource')}</button></p>}
    {message && <p className="inline-state" role={message === t('settings.shares.revoked') ? 'status' : 'alert'}>{message}</p>}
    {error && <p className="inline-state" role="alert">{t('settings.shares.loadFailed')} <button type="button" className="button button-secondary" onClick={() => void load(error.cursor)}>{t('common.retry')}</button></p>}
    {!loading && !error && items.length === 0 && <p className="inline-state">{t('settings.shares.empty')}</p>}
    <div className="managed-shares-list">
      {items.map((item) => <div className="managed-share" key={item.id}>
        <div className="managed-share-info">
          <strong>{item.resource_name || t('settings.shares.unknownResource')}</strong>
          <span>{t(item.resource_type === 'photo' ? 'common.photo' : 'common.folder')} · {t(`settings.shares.status.${item.status}`)}</span>
          <small>{t('settings.shares.created')}: {date(item.created_at)} · {t('settings.shares.expires')}: {item.expires_at ? date(item.expires_at) : t('settings.shares.never')} · {item.password_protected ? t('settings.shares.passwordYes') : t('settings.shares.passwordNo')}</small>
        </div>
        <div className="managed-share-actions">
          {item.status !== 'unavailable' && <button type="button" className="button button-secondary" disabled={busyID === item.id} onClick={() => void open(item)}>{t('settings.shares.open')}</button>}
          {item.status !== 'unavailable' && <button type="button" className="button button-secondary" onClick={() => setNewShare(item)}>{t('settings.shares.new')}</button>}
          {item.status !== 'revoked' && <button type="button" className="button button-secondary" disabled={busyID === item.id} onClick={() => setConfirm(item.id)}>{t('settings.shares.revoke')}</button>}
        </div>
        {confirm === item.id && <div className="managed-share-confirm" role="group" aria-label={t('settings.shares.confirm')}>
          <p>{t('settings.shares.confirm')}</p>
          <button type="button" className="button button-secondary" onClick={() => setConfirm(null)}>{t('common.cancel')}</button>
          <button type="button" className="button button-primary" disabled={busyID === item.id} onClick={() => void revoke(item.id)}>{t('settings.shares.revoke')}</button>
        </div>}
      </div>)}
    </div>
    {cursor && <button type="button" className="button button-secondary managed-shares-more" disabled={loading} onClick={() => void load(cursor)}>{t('settings.shares.more')}</button>}
    {newShare && <ShareDialog api={api} resource={{ type: newShare.resource_type, id: newShare.resource_id, name: newShare.resource_name }} onClose={() => { setNewShare(null); void load(); }} />}
    {photo && <Viewer api={api} photos={[photo]} selected={0} onClose={() => setPhoto(null)} onDeleted={() => { setPhoto(null); void load(); }} onUpdated={(updated) => { setPhoto(updated); void load(); }} />}
  </SettingsCard>;
}
