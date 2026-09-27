import { useId, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';

type SettingsCardProps = {
  title: string;
  summary: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  details?: ReactNode;
  tone?: 'default' | 'danger';
  children?: ReactNode;
};

/**
 * One settings topic: a title with a one-line summary and its main actions,
 * longer notes collapsed behind "Learn more", then the topic's own state.
 */
export default function SettingsCard({ title, summary, icon: Icon, actions, details, tone = 'default', children }: SettingsCardProps) {
  const { t } = useI18n();
  const headingID = useId();
  return <section className={`settings-card ${tone === 'danger' ? 'is-danger' : ''}`} aria-labelledby={headingID}>
    <div className="settings-card-header">
      <div className="settings-card-title">
        {Icon && <Icon size={17} aria-hidden="true" />}
        <div><h2 id={headingID}>{title}</h2><p>{summary}</p></div>
      </div>
      {actions && <div className="settings-card-actions">{actions}</div>}
    </div>
    {details && <details className="settings-card-details"><summary>{t('settings.learnMore')}</summary><div>{details}</div></details>}
    {children}
  </section>;
}
