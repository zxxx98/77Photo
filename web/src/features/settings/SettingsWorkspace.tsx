import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { UserRound } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';
import type { ApiClient, User } from '../../app/api';
import { readSettingsSection, settingsSectionHash, type SettingsSection } from '../../app/routes';
import AccountSection from './AccountSection';
import LibrarySection from './LibrarySection';
import MembersSection from './MembersSection';
import { useLibraryMaintenance } from './useLibraryMaintenance';

const sections: SettingsSection[] = ['account', 'members', 'library'];

export default function SettingsWorkspace({ api, currentUser, onOpenFolder }: { api: ApiClient; currentUser: User; onOpenFolder?: (folder: { id: string; name: string }) => void }) {
  const { t } = useI18n();
  const isAdmin = currentUser.role === 'admin';
  const [section, setSection] = useState<SettingsSection>(() => isAdmin ? readSettingsSection(window.location.hash) : 'account');
  const [users, setUsers] = useState<User[]>([]);
  const [usersError, setUsersError] = useState<string | null>(null);
  const maintenance = useLibraryMaintenance(api, isAdmin, users, currentUser.id);
  const tabRefs = useRef<Partial<Record<SettingsSection, HTMLButtonElement | null>>>({});

  useEffect(() => {
    if (!isAdmin) return;
    void api.listUsers().then((response) => setUsers(response.items)).catch(() => setUsersError(t('settings.usersLoadFailed')));
  }, [api, isAdmin, t]);

  useEffect(() => {
    const onPopState = () => setSection(isAdmin ? readSettingsSection(window.location.hash) : 'account');
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [isAdmin]);

  function select(next: SettingsSection, focus = false) {
    setSection(next);
    // Replace rather than push so Back still leaves the settings page.
    window.history.replaceState(window.history.state, '', settingsSectionHash(next));
    if (focus) tabRefs.current[next]?.focus();
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const index = sections.indexOf(section);
    const next = event.key === 'ArrowRight' ? sections[(index + 1) % sections.length]
      : event.key === 'ArrowLeft' ? sections[(index - 1 + sections.length) % sections.length]
        : event.key === 'Home' ? sections[0]
          : event.key === 'End' ? sections[sections.length - 1]
            : null;
    if (!next) return;
    event.preventDefault();
    select(next, true);
  }

  function panelProps(id: SettingsSection) {
    return isAdmin
      ? { id: `settings-panel-${id}`, role: 'tabpanel', 'aria-labelledby': `settings-tab-${id}`, hidden: section !== id }
      : { id: `settings-panel-${id}` };
  }

  return <section className="settings-workspace" aria-labelledby="settings-title">
    <div className="workspace-heading">
      <div><span className="eyebrow">{isAdmin ? t('settings.adminEyebrow') : t('settings.yourAccount')}</span><h1 id="settings-title">{t('settings.title')}</h1></div>
      <UserRound size={21} />
    </div>
    {isAdmin && <div className="settings-tabs" role="tablist" aria-label={t('settings.title')}>
      {sections.map((id) => <button
        key={id}
        ref={(element) => { tabRefs.current[id] = element; }}
        id={`settings-tab-${id}`}
        className="settings-tab"
        type="button"
        role="tab"
        aria-selected={section === id}
        aria-controls={`settings-panel-${id}`}
        tabIndex={section === id ? 0 : -1}
        onClick={() => select(id)}
        onKeyDown={onTabKeyDown}
      >
        {t(`settings.tabs.${id}`)}
        {id === 'library' && maintenance.currentTask && <span className="settings-tab-dot" aria-hidden="true" />}
      </button>)}
    </div>}
    <div className="settings-panel" {...panelProps('account')}>
      <AccountSection api={api} currentUser={currentUser} onOpenFolder={onOpenFolder} />
    </div>
    {isAdmin && <>
      <div className="settings-panel" {...panelProps('members')}>
        <MembersSection
          api={api}
          currentUser={currentUser}
          users={users}
          setUsers={setUsers}
          loadError={usersError}
          maintenanceBusy={maintenance.busy}
          onMaintenanceConflict={() => void maintenance.sync()}
        />
      </div>
      <div className="settings-panel" {...panelProps('library')}>
        <LibrarySection api={api} maintenance={maintenance} />
      </div>
    </>}
  </section>;
}
