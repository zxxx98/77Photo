import { useCallback, useEffect, useRef, useState } from 'react';
import { ScanFace } from 'lucide-react';
import type { FacesAPI, FaceConfig, FaceJob, FailedFaceItem } from './types';
import { useI18n } from '../../app/I18nProvider';
import SettingsCard from '../settings/SettingsCard';
import { faceStrings } from './strings';
import './PeopleWorkspace.css';

export default function FaceScanPanel({ api, onCompleted, placement = 'people' }: { api: FacesAPI; onCompleted?: () => void | Promise<void>; placement?: 'people' | 'settings' }) {
  const { locale } = useI18n(); const s = faceStrings(locale);
  const [config, setConfig] = useState<FaceConfig>();
  const [job, setJob] = useState<FaceJob>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failedItems, setFailedItems] = useState<FailedFaceItem[]>([]);
  const [failureNext, setFailureNext] = useState('');
  const [confirmation, setConfirmation] = useState<'regroup' | 'full' | ''>('');
  const key = useRef<string>();
  const notified = useRef<string>();
  useEffect(() => { setFailedItems([]); setFailureNext(''); }, [job?.id]);
  useEffect(() => {
    if (job && ['completed', 'completed_with_errors'].includes(job.status) && notified.current !== job.id) {
      notified.current = job.id;
      void onCompleted?.();
    }
  }, [job?.id, job?.status, onCompleted]);
  const refresh = useCallback(async () => {
    const [c, j] = await Promise.all([api.config(), api.jobs()]);
    setConfig(c); setJob(j.items[0]);
  }, [api]);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try { const [c, j] = await Promise.all([api.config(), api.jobs()]); if (alive) { setConfig(c); setJob(j.items[0]); } }
      catch { if (alive) setMessage(s.error); }
    };
    void poll(); const timer = window.setInterval(() => void poll(), 2000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [api, s.error]);
  async function act(fn: () => Promise<unknown>, success = '') {
    setBusy(true); setMessage('');
    try { await fn(); await refresh(); setMessage(success); }
    catch { setMessage(s.error); }
    finally { setBusy(false); }
  }
  const active = job && ['running', 'paused', 'paused_offline'].includes(job.status);
  const start = (mode: 'incremental' | 'retry_failed' | 'regroup' | 'full') => act(async () => {
    key.current ??= globalThis.crypto?.randomUUID?.() ?? `face-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await api.start(mode, key.current); key.current = undefined;
  });
  async function loadFailures(cursor = '') {
    if (!job) return;
    try {
      const page = await api.failedItems(job.id, cursor);
      setFailedItems(items => cursor ? [...items, ...page.items] : page.items);
      setFailureNext(page.next_cursor);
    } catch { setMessage(s.error); }
  }
  const actions = <div className="face-actions">
      <button className="button button-secondary" disabled={busy || !config?.enabled} onClick={() => void act(() => api.test(), s.online)}>{s.test}</button>
      <button className="button button-primary" disabled={busy || !config?.enabled || !!active} onClick={() => void start('incremental')}>{s.start}</button>
      <button className="button button-secondary" disabled={busy || !config?.enabled || !!active} onClick={() => void start('retry_failed')}>{s.retry}</button>
      {placement === 'settings' && <>
        <button className="button button-secondary" disabled={busy || !config?.enabled || !!active} onClick={() => setConfirmation('regroup')}>{s.regroup}</button>
        <button className="button button-secondary" disabled={busy || !config?.enabled || !!active} onClick={() => setConfirmation('full')}>{s.full}</button>
      </>}
    </div>;
  const content = <>
    {config && !config.enabled && <p>{s.disabled}</p>}
    {config?.enabled && !config.automatic_matching && <p className="inline-state">{s.manual}</p>}
    {config?.enabled && <p className="inline-state">{s.scanSettings}: {config.match_threshold} · {s.marginSetting}: {config.match_margin} · {s.concurrencySetting}: {config.concurrency}</p>}
    {confirmation && <div className="face-confirmation" role="group" aria-label={s.confirmAction}><p>{confirmation === 'full' ? s.fullWarning : s.regroupWarning}</p><button className="button button-primary" disabled={busy || !!active} onClick={() => void start(confirmation).then(() => setConfirmation(''))}>{s.confirmAction}</button><button className="text-button" disabled={busy} onClick={() => setConfirmation('')}>{s.dismiss}</button></div>}
    {job && <div className="face-job" aria-live="polite">
      <strong>{s.history}: {s[job.mode as keyof typeof s] ?? job.mode} · {s[job.status as keyof typeof s] ?? job.status}</strong>
      <p>{s.progress} {job.counts.total - job.counts.pending} / {job.counts.total} · {job.counts.failed} {s.failures}</p>
      {job.status === 'running' && <progress max={Math.max(1, job.counts.total)} value={job.counts.total - job.counts.pending} aria-label={s.progress} />}
      {job.error && <p className="inline-state">{job.error}</p>}
      {job.counts.failed > 0 && <div><button className="text-button" onClick={() => void loadFailures()}>{s.showFailures}</button>
        {failedItems.length > 0 && <ul>{failedItems.map(item => <li key={item.photo_id}>{item.filename || item.photo_id}: {item.error === 'MANUAL_FACE_UNMATCHED' ? s.manualUnmatched : item.error}</li>)}</ul>}
        {failureNext && <button className="text-button" onClick={() => void loadFailures(failureNext)}>{s.more}</button>}
      </div>}
      <div className="face-actions">
        {job.status === 'running' && <button className="button button-secondary" disabled={busy} onClick={() => void act(() => api.control(job.id, 'pause'))}>{s.pause}</button>}
        {['paused', 'paused_offline'].includes(job.status) && <button className="button button-primary" disabled={busy || !config?.enabled} onClick={() => void act(() => api.control(job.id, 'resume'))}>{s.resume}</button>}
        {active && <button className="button button-secondary" disabled={busy} onClick={() => void act(() => api.control(job.id, 'cancel'))}>{s.cancel}</button>}
      </div>
    </div>}
    {message && <p role="status">{message}</p>}
  </>;
  if (placement === 'settings') return <SettingsCard icon={ScanFace} title={s.scan} summary={s.privacy} actions={actions}>
    <div className="face-scan-settings">{content}</div>
  </SettingsCard>;
  return <section className="face-scan-panel" aria-label={s.scan}>
    <h2>{s.scan}</h2><p className="inline-state">{s.privacy}</p>
    {actions}
    {content}
  </section>;
}
