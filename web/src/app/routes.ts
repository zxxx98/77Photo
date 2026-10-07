export type AppView = 'gallery' | 'folders' | 'map' | 'settings' | 'people' | 'upload' | 'trash' | 'duplicates';

const appViews: AppView[] = ['gallery', 'folders', 'map', 'settings', 'people', 'upload', 'trash', 'duplicates'];

export interface MapFocus {
  lat: number;
  lng: number;
  zoom: number;
}

export function readPublicShareToken(hash: string): string | null {
  const match = /^#\/share\/([^/]+)$/.exec(hash);
  return match?.[1] ?? null;
}

export function readView(hash: string): AppView {
  const value = hash.replace(/^#\/?/, '').split('?')[0] as AppView;
  return appViews.includes(value) ? value : 'gallery';
}

/** Reads the position a "view on map" link asks the map to show. */
export function readMapFocus(hash: string): MapFocus | null {
  const match = /^#\/map\?(.*)$/.exec(hash);
  if (!match) return null;
  const params = new URLSearchParams(match[1]);
  const lat = coordinate(params.get('lat'));
  const lng = coordinate(params.get('lng'));
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const zoom = coordinate(params.get('z'));
  return { lat, lng, zoom: zoom === null ? 16 : Math.min(18, Math.max(1, Math.round(zoom))) };
}

export function mapFocusHash(focus: MapFocus): string {
  return `#/map?lat=${focus.lat.toFixed(6)}&lng=${focus.lng.toFixed(6)}&z=${focus.zoom}`;
}

export type SettingsSection = 'account' | 'members' | 'library';

const settingsSections: SettingsSection[] = ['account', 'members', 'library'];

/** Reads which settings tab the URL asks for; anything unknown opens the account tab. */
export function readSettingsSection(hash: string): SettingsSection {
  const match = /^#\/settings\?(.*)$/.exec(hash);
  const value = match ? new URLSearchParams(match[1]).get('section') : null;
  return settingsSections.includes(value as SettingsSection) ? value as SettingsSection : 'account';
}

export function settingsSectionHash(section: SettingsSection): string {
  return section === 'account' ? '#/settings' : `#/settings?section=${section}`;
}

export function shareManagementHash(type: 'photo' | 'folder', id: string): string {
  const query = new URLSearchParams({ resource_type: type, resource_id: id });
  return `#/settings?${query}`;
}

export function readShareManagementResource(hash: string): { type: 'photo' | 'folder'; id: string } | null {
  const match = /^#\/settings\?(.*)$/.exec(hash);
  if (!match) return null;
  const query = new URLSearchParams(match[1]);
  const type = query.get('resource_type');
  const id = query.get('resource_id');
  return (type === 'photo' || type === 'folder') && id ? { type, id } : null;
}

function coordinate(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
