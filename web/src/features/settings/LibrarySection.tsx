import { FolderInput, ImageIcon, ImageOff, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';
import type { ApiClient } from '../../app/api';
import FaceScanPanel from '../people/FaceScanPanel';
import SettingsCard from './SettingsCard';
import UserPicker from './UserPicker';
import type { LibraryMaintenance } from './useLibraryMaintenance';

export default function LibrarySection({ api, maintenance }: { api: ApiClient; maintenance: LibraryMaintenance }) {
  const { t, formatCount } = useI18n();
  const { busy, currentTask, scan, thumbnail, importer, cleanup } = maintenance;

  const scanJob = scan.job;
  const counts = scanJob?.counts;
  const scanStatusLabel = scanJob?.status === 'running'
    ? t(`settings.scanPhase.${scanJob.phase ?? 'discovering'}`)
    : scanJob?.status === 'completed'
      ? t('settings.scanCompleted')
      : scanJob?.status === 'failed'
        ? t('settings.scanRunFailed')
        : t('settings.scanQueued');
  const scanPercent = scanJob?.status === 'completed' ? 100
    : scanJob?.phase === 'indexing' && (scanJob.total ?? 0) > 0
      ? Math.min(99, Math.round(((scanJob.processed ?? 0) / scanJob.total!) * 100)) : undefined;
  const thumbnailJob = thumbnail.job;
  const thumbnailStatusLabel = thumbnailJob?.status === 'running'
    ? t('settings.thumbnail.running')
    : thumbnailJob?.status === 'completed'
      ? t('settings.thumbnail.completed')
      : thumbnailJob?.status === 'failed'
        ? t('settings.thumbnail.failed')
        : t('settings.thumbnail.queued');
  const thumbnailCounts = thumbnailJob?.counts;
  const thumbnailPercent = thumbnailCounts && thumbnailCounts.total > 0
    ? Math.min(100, Math.round((thumbnailCounts.processed / thumbnailCounts.total) * 100))
    : thumbnailJob?.status === 'completed' ? 100 : 0;
  const importJob = importer.job;
  const importStatusLabel = importJob?.status === 'running'
    ? t('settings.import.running')
    : importJob?.status === 'completed'
      ? t('settings.import.completed')
      : importJob?.status === 'failed'
        ? t('settings.import.failed')
        : t('settings.import.queued');
  const brokenPhotos = cleanup.result;

  return <>
    {currentTask && <p className="settings-notice is-busy" role="status">{t('settings.maintenance.busy', { task: t(`settings.maintenance.task.${currentTask}`) })}</p>}

    <SettingsCard
      icon={RefreshCw}
      title={t('settings.libraryIndex')}
      summary={t('settings.scan.summary')}
      actions={<button className="button button-secondary" disabled={busy} onClick={() => void scan.start()}><RefreshCw size={15} /> {t('settings.rescanFiles')}</button>}
    >
      {scan.message && <p className="inline-state" role="alert">{scan.message}</p>}
      {scanJob && counts && <div className="scan-progress" role="status" aria-live="polite">
        <div className="scan-progress-heading"><span>{scanStatusLabel}</span><span>{scanJob.total !== undefined && scanJob.phase !== 'discovering' && scanJob.phase !== 'resetting' ? `${formatCount(scanJob.processed ?? 0)} / ${formatCount(scanJob.total)}` : formatCount(counts.scanned)}</span></div>
        <div className={`progress-track scan-progress-track ${scan.active && scanPercent === undefined ? 'is-active' : ''}`} role="progressbar" aria-label={scanStatusLabel} aria-valuemin={0} aria-valuemax={100} {...(scanPercent !== undefined ? { 'aria-valuenow': scanPercent } : {})}>
          <span style={scanPercent !== undefined ? { width: `${scanPercent}%` } : undefined} className={scanJob.status === 'completed' ? 'is-complete' : ''} />
        </div>
        <div className="scan-progress-counts">
          <span>{t('settings.scanScanned', { count: formatCount(counts.scanned) })}</span>
          <span>{t('settings.scanAdded', { count: formatCount(counts.added) })}</span>
          <span>{t('settings.scanUpdated', { count: formatCount(counts.updated) })}</span>
          <span>{t('settings.scanMissing', { count: formatCount(counts.missing) })}</span>
          <span>{t('settings.scanErrors', { count: formatCount(counts.failed) })}</span>
        </div>
      </div>}
    </SettingsCard>

    <SettingsCard
      icon={FolderInput}
      title={t('settings.import.title')}
      summary={t('settings.import.summary')}
      details={<>
        <p>{t('settings.import.sourceHelp')}</p>
        <p>{t('settings.import.warning')}</p>
        <p id="import-organize-help">{t('settings.import.organizeHelp')}</p>
      </>}
    >
      <form className="new-user-form" onSubmit={importer.start}>
        <input aria-label={t('settings.import.source')} placeholder="." value={importer.source} onChange={(event) => importer.setSource(event.target.value)} disabled={busy} />
        <UserPicker
          users={importer.targets}
          value={importer.targetID}
          label={t('settings.import.targetUser')}
          disabled={busy}
          onChange={importer.setTargetID}
        />
        <button className="button button-secondary" disabled={busy || !importer.targetID}>{importer.active ? t('settings.import.running') : t('settings.import.start')}</button>
      </form>
      <label className="import-organize-option">
        <input type="checkbox" checked={importer.organizeByDate} onChange={(event) => importer.setOrganizeByDate(event.target.checked)} disabled={busy} aria-describedby="import-organize-help" />
        <span>{t('settings.import.organizeByDate')}</span>
      </label>
      {importer.message && <p className="inline-state" role="alert">{importer.message}</p>}
      {importJob && <div className="scan-progress" role="status" aria-live="polite">
        <div className="scan-progress-heading"><span>{importStatusLabel}</span><span>{formatCount(importJob.counts.scanned)}</span></div>
        <div className={`progress-track scan-progress-track ${importer.active ? 'is-active' : ''}`} role="progressbar" aria-label={importStatusLabel} aria-valuemin={0} aria-valuemax={100} {...(importJob.status === 'completed' ? { 'aria-valuenow': 100 } : {})}>
          <span className={importJob.status === 'completed' ? 'is-complete' : ''} />
        </div>
        <div className="scan-progress-counts">
          <span>{t('settings.import.scanned')}: {formatCount(importJob.counts.scanned)}</span>
          <span>{t('settings.import.moved')}: {formatCount(importJob.counts.moved)}</span>
          <span>{t('settings.import.skipped')}: {formatCount(importJob.counts.skipped)}</span>
          <span>{t('settings.import.errors')}: {formatCount(importJob.counts.failed)}</span>
        </div>
      </div>}
    </SettingsCard>

    <SettingsCard
      icon={ImageIcon}
      title={t('settings.thumbnail.title')}
      summary={<>{t('settings.thumbnail.summary')}<span className="settings-card-note">{thumbnail.mode === 'incremental' ? t('settings.thumbnail.incrementalHelp') : t('settings.thumbnail.fullHelp')}</span></>}
      details={<p>{t('settings.thumbnail.warning')}</p>}
      actions={<>
        <div className="thumbnail-mode-toggle" role="group" aria-label={t('settings.thumbnail.modeLabel')}>
          <button
            type="button"
            className={`thumbnail-mode-button ${thumbnail.mode === 'incremental' ? 'is-selected' : ''}`}
            aria-pressed={thumbnail.mode === 'incremental'}
            disabled={busy}
            onClick={() => thumbnail.setMode('incremental')}
          >{t('settings.thumbnail.incremental')}</button>
          <button
            type="button"
            className={`thumbnail-mode-button ${thumbnail.mode === 'full' ? 'is-selected' : ''}`}
            aria-pressed={thumbnail.mode === 'full'}
            disabled={busy}
            onClick={() => thumbnail.setMode('full')}
          >{t('settings.thumbnail.full')}</button>
        </div>
        <button className="button button-secondary" disabled={busy} onClick={() => void thumbnail.start()}><ImageIcon size={15} /> {thumbnail.active ? t('settings.thumbnail.running') : t('settings.thumbnail.rebuild')}</button>
      </>}
    >
      {thumbnail.message && <p className="inline-state" role="alert">{thumbnail.message}</p>}
      {thumbnailJob && thumbnailCounts && <div className="scan-progress" role="status" aria-live="polite">
        <div className="scan-progress-heading"><span>{thumbnailStatusLabel}</span><span>{thumbnailPercent}%</span></div>
        <div className={`progress-track scan-progress-track ${thumbnail.active ? 'is-active' : ''}`} role="progressbar" aria-label={thumbnailStatusLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={thumbnailPercent}>
          <span className={thumbnailJob.status === 'completed' ? 'is-complete' : ''} style={{ width: `${thumbnailPercent}%` }} />
        </div>
        <div className="scan-progress-counts">
          <span>{t('settings.thumbnail.total')}: {formatCount(thumbnailCounts.total)}</span>
          <span>{t('settings.thumbnail.processed')}: {formatCount(thumbnailCounts.processed)}</span>
          <span>{t('settings.thumbnail.regenerated')}: {formatCount(thumbnailCounts.regenerated)}</span>
          <span>{t('settings.import.errors')}: {formatCount(thumbnailCounts.failed)}</span>
        </div>
      </div>}
    </SettingsCard>

    <SettingsCard
      icon={ImageOff}
      title={t('settings.cleanup.title')}
      summary={t('settings.cleanup.summary')}
      details={<p>{t('settings.cleanup.warning')}</p>}
      actions={<>
        <button className="button button-secondary" disabled={busy} onClick={() => void cleanup.scan()}><RefreshCw size={15} /> {cleanup.action === 'scan' ? t('settings.cleanup.scanning') : t('settings.cleanup.scan')}</button>
        {brokenPhotos && brokenPhotos.broken > 0 && <button className="button button-danger" disabled={busy} onClick={() => void cleanup.clean()}><Trash2 size={15} /> {cleanup.action === 'clean' ? t('settings.cleanup.cleaning') : t('settings.cleanup.clean', { count: formatCount(brokenPhotos.broken) })}</button>}
      </>}
    >
      {cleanup.message && <p className="inline-state" role="status">{cleanup.message}</p>}
      {brokenPhotos && brokenPhotos.broken > 0 && <div className="scan-progress" aria-live="polite">
        <div className="scan-progress-counts">
          <span>{t('settings.import.scanned')}: {formatCount(brokenPhotos.scanned)}</span>
          <span>{t('settings.cleanup.title')}: {formatCount(brokenPhotos.broken)}</span>
        </div>
        <div className="scan-progress-counts">
          {brokenPhotos.items.slice(0, 8).map((item) => <span key={item.id}>{item.filename} · {item.reason === 'missing' ? t('settings.cleanup.missingReason') : t('settings.cleanup.emptyReason')}</span>)}
          {brokenPhotos.items.length > 8 && <span>+{formatCount(brokenPhotos.items.length - 8)}</span>}
        </div>
      </div>}
    </SettingsCard>

    {api.faces && <FaceScanPanel api={api.faces} />}

    <SettingsCard
      icon={TriangleAlert}
      tone="danger"
      title={t('settings.danger.title')}
      summary={t('settings.reset.summary')}
      details={<p>{t('settings.reset.help')}</p>}
      actions={<button className="button button-danger" disabled={busy} onClick={() => void scan.reset()}><Trash2 size={15} /> {t('settings.reset.action')}</button>}
    />
  </>;
}
