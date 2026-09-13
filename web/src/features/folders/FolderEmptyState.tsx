import { FolderPlus, Upload } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';

export default function FolderEmptyState({ onUpload, onCreateFolder }: { onUpload: () => void; onCreateFolder: () => void }) {
  const { t } = useI18n();
  return <div className="folder-empty-state"><div className="folder-empty-copy"><span className="eyebrow">{t('folders.emptyEyebrow')}</span><h2>{t('folders.emptyTitle')}</h2><p>{t('folders.emptyDescription')}</p><div className="folder-empty-actions"><button className="button button-primary" type="button" onClick={onUpload}><Upload size={17} /> {t('folders.emptyUpload')}</button><button className="button button-secondary" type="button" onClick={onCreateFolder}><FolderPlus size={17} /> {t('folders.emptyCreate')}</button></div></div><div className="folder-empty-photo-stack" aria-hidden="true"><span className="folder-empty-print folder-empty-print-sage" /><span className="folder-empty-print folder-empty-print-blush" /><span className="folder-empty-print folder-empty-print-main"><i /></span><span className="folder-empty-stamp">77</span></div></div>;
}
