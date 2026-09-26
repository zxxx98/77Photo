import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, CirclePlay, LoaderCircle } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';
import type { Photo } from '../../app/api';

// Selection props are optional so read-only lists, such as the map panel,
// can reuse the timeline layout.
export function TimelineGroup({ date, heading, photos, selectionMode = false, selectedIds = noSelection, selectDayLabel = '', selectedLabel = '', deselectedLabel = '', onToggleDay = noop, onToggle = noop, onSelect }: {
  date: string;
  /** Replaces the formatted day, for lists grouped by a longer period. */
  heading?: string;
  photos: Photo[];
  selectionMode?: boolean;
  selectedIds?: Set<string>;
  selectDayLabel?: string;
  selectedLabel?: string;
  deselectedLabel?: string;
  onToggleDay?: () => void;
  onToggle?: (id: string) => void;
  onSelect: (photo: Photo) => void;
}) {
  const { t, formatCount, formatCalendarDate } = useI18n();
  return (
    <div className="timeline-group">
      <div className="date-heading">
        <h2>{heading ?? formatCalendarDate(date)}</h2>
        <div style={dateActionsStyle}>
          <span>{photos.length === 1 ? t('gallery.onePhoto', { count: formatCount(photos.length) }) : t('gallery.manyPhotos', { count: formatCount(photos.length) })}</span>
          {selectionMode && <button type="button" className="button button-secondary" style={daySelectButtonStyle} onClick={onToggleDay}>{selectDayLabel}</button>}
        </div>
      </div>
      <div className="photo-grid">
        {photos.map((photo) => (
          <PhotoTile
            key={photo.id}
            photo={photo}
            selectionMode={selectionMode}
            selected={selectedIds.has(photo.id)}
            onToggle={onToggle}
            onSelect={onSelect}
            selectedLabel={selectedLabel}
            deselectedLabel={deselectedLabel}
          />
        ))}
      </div>
    </div>
  );
}

export function PhotoTile({ photo, selectionMode, selected, onToggle, onSelect, selectedLabel, deselectedLabel }: {
  photo: Photo;
  selectionMode: boolean;
  selected: boolean;
  onToggle: (id: string) => void;
  onSelect: (photo: Photo) => void;
  selectedLabel: string;
  deselectedLabel: string;
}) {
  const { t } = useI18n();
  const isVideo = photo.mime_type.startsWith('video/');
  const [previewMode, setPreviewMode] = useState<'thumbnail' | 'original' | 'video-placeholder' | 'image-placeholder' | 'failed'>('thumbnail');
  const [thumbnailAttempt, setThumbnailAttempt] = useState(0);
  const [previewReady, setPreviewReady] = useState(false);
  const retryTimer = useRef<number | null>(null);
  const failed = previewMode === 'failed';
  const previewSource = previewMode === 'original'
    ? `/api/v1/photos/${encodeURIComponent(photo.id)}/original`
    : previewMode === 'video-placeholder'
      ? videoPlaceholderSource
      : previewMode === 'image-placeholder'
        ? '/image-placeholder.svg'
        : `/api/v1/photos/${encodeURIComponent(photo.id)}/thumbnail?size=256&retry=${thumbnailAttempt}`;

  useEffect(() => () => {
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
  }, []);

  function handlePreviewLoad() {
    setPreviewReady(true);
  }

  function handlePreviewError() {
    setPreviewReady(false);
    if (previewMode === 'thumbnail') {
      if (thumbnailAttempt < thumbnailRetryLimit) {
        if (retryTimer.current === null) {
          retryTimer.current = window.setTimeout(() => {
            retryTimer.current = null;
            setThumbnailAttempt((attempt) => attempt + 1);
          }, thumbnailRetryDelayMS);
        }
        return;
      }
      setPreviewMode(isVideo ? 'video-placeholder' : 'original');
      return;
    }
    setPreviewMode(previewMode === 'original' ? 'image-placeholder' : 'failed');
  }

  const activate = () => selectionMode ? onToggle(photo.id) : onSelect(photo);
  const loadingPreview = !failed && !previewReady;
  return (
    <figure
      className="photo-tile"
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={selectionMode ? `${selected ? deselectedLabel : selectedLabel}: ${photo.filename}` : photo.filename}
      aria-pressed={selectionMode ? selected : undefined}
    >
      <div className={`photo-frame ${failed ? 'is-failed' : ''}`} style={selectionMode && selected ? selectedFrameStyle : undefined}>
        {failed ? <span>{t('gallery.previewPending')}</span> : <>
          <img
            src={previewSource}
            alt={photo.filename}
            loading="lazy"
            decoding="async"
            onLoad={handlePreviewLoad}
            onError={handlePreviewError}
            style={previewReady ? undefined : hiddenPreviewStyle}
          />
          {loadingPreview && <span style={previewLoadingStyle} aria-hidden="true"><LoaderCircle className="spin" size={20} /></span>}
        </>}
        {photo.is_live_photo && !failed && <span title="Live Photo" style={{ position: 'absolute', left: 9, top: 9, display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 999, padding: '5px 7px', background: 'rgba(32,37,45,.72)', color: '#fff', fontSize: 9, fontWeight: 700, letterSpacing: '.08em', pointerEvents: 'none' }}><CirclePlay size={12} /> LIVE</span>}
        {selectionMode && <span style={{ ...selectionBadgeStyle, ...(selected ? selectedBadgeStyle : {}) }} aria-hidden="true">{selected && <Check size={14} />}</span>}
      </div>
      <figcaption>{photo.filename}</figcaption>
    </figure>
  );
}

export function groupByDate(photos: Photo[]): Array<[string, Photo[]]> {
  return groupByPrefix(photos, 10);
}

/** Groups by the UTC capture month ("2026-09"), for denser overviews. */
export function groupByMonth(photos: Photo[]): Array<[string, Photo[]]> {
  return groupByPrefix(photos, 7);
}

function groupByPrefix(photos: Photo[], length: number): Array<[string, Photo[]]> {
  const groups = new Map<string, Photo[]>();
  for (const photo of photos) {
    const key = photo.captured_at.slice(0, length);
    const current = groups.get(key) ?? [];
    current.push(photo);
    groups.set(key, current);
  }
  return [...groups.entries()];
}

const noSelection = new Set<string>();
const noop = () => undefined;
const thumbnailRetryLimit = 2;
const thumbnailRetryDelayMS = 1000;
const videoPlaceholderSource = '/video-placeholder.svg';
const hiddenPreviewStyle: CSSProperties = { visibility: 'hidden' };
const previewLoadingStyle: CSSProperties = { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'rgba(32,37,45,.5)', pointerEvents: 'none' };

const selectionBadgeStyle: CSSProperties = {
  position: 'absolute',
  right: 9,
  top: 9,
  width: 24,
  height: 24,
  borderRadius: '50%',
  border: '2px solid rgba(255,255,255,.95)',
  background: 'rgba(32,37,45,.42)',
  color: '#fff',
  display: 'grid',
  placeItems: 'center',
  boxShadow: '0 1px 5px rgba(0,0,0,.22)',
  pointerEvents: 'none',
};

const selectedBadgeStyle: CSSProperties = { background: '#20252d' };
const selectedFrameStyle: CSSProperties = { boxShadow: 'inset 0 0 0 3px #20252d' };
const dateActionsStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 };
const daySelectButtonStyle: CSSProperties = { padding: '6px 10px', minHeight: 0, fontSize: 12 };
