import { useCallback, useEffect, useRef, useState } from 'react';
import type { FacesAPI, FaceConfig, FaceJob } from './types';
import { useI18n } from '../../app/I18nProvider';
import { faceStrings } from './strings';
import './PeopleWorkspace.css';

export default function FaceScanPanel({ api }: { api: FacesAPI }) {
  const { locale } = useI18n(); const s = faceStrings(locale);
  const [config, setConfig] = useState<FaceConfig>();
  const [job, setJob] = useState<FaceJob>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const key = useRef<string>();
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
  const start = (mode: 'incremental' | 'retry_failed') => act(async () => {
    key.current ??= globalThis.crypto?.randomUUID?.() ?? `face-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await api.start(mode, key.current); key.current = undefined;
  });
  return <section className="face-scan-panel" aria-label={s.scan}>
    <h2>{s.scan}</h2><p className="inline-state">{s.privacy}</p>
    {config && !config.enabled && <p>{s.disabled}</p>}
    {config?.enabled && !config.automatic_matching && <p className="inline-state">{s.manual}</p>}
    <div className="face-actions">
      <button className="button button-secondary" disabled={busy || !config?.enabled} onClick={() => void act(() => api.test(), s.online)}>{s.test}</button>
      <button className="button button-primary" disabled={busy || !config?.enabled || !!active} onClick={() => void start('incremental')}>{s.start}</button>
      <button className="button button-secondary" disabled={busy || !config?.enabled || !!active} onClick={() => void start('retry_failed')}>{s.retry}</button>
    </div>
    {job && <div className="face-job" aria-live="polite">
      <strong>{s.history}: {s[job.status as keyof typeof s] ?? job.status}</strong>
      <p>{s.progress} {job.counts.total - job.counts.pending} / {job.counts.total} · {job.counts.failed} {s.failures}</p>
      {job.status === 'running' && <progress max={Math.max(1, job.counts.total)} value={job.counts.total - job.counts.pending} aria-label={s.progress} />}
      {job.error && <p className="inline-state">{job.error}</p>}
      <div className="face-actions">
        {job.status === 'running' && <button className="button button-secondary" disabled={busy} onClick={() => void act(() => api.control(job.id, 'pause'))}>{s.pause}</button>}
        {['paused', 'paused_offline'].includes(job.status) && <button className="button button-primary" disabled={busy || !config?.enabled} onClick={() => void act(() => api.control(job.id, 'resume'))}>{s.resume}</button>}
        {active && <button className="button button-secondary" disabled={busy} onClick={() => void act(() => api.control(job.id, 'cancel'))}>{s.cancel}</button>}
      </div>
    </div>}
    {message && <p role="status">{message}</p>}
  </section>;
}
