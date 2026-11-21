import {useCallback, useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {ApiError} from '../auth/api';
import {BrowseApi, errorState, type LoadState, type Photo, type PhotoFilters} from './api';

// reset: the query changed, so the old list is meaningless and is cleared.
// refresh: the user asked for fresh data; the old list stays visible meanwhile.
// revalidate: something may have changed elsewhere; update quietly in place.
type Mode = 'reset' | 'refresh' | 'revalidate' | 'more';

// Splices a freshly fetched first page onto the loaded list. Returns null when
// the two no longer overlap, in which case the fresh page replaces the list.
export function mergeFirstPage(old: Photo[], fresh: Photo[]): Photo[] | null {
  const last = fresh[fresh.length - 1];
  if (!last) {return null;}
  const index = old.findIndex(photo => photo.id === last.id);
  if (index < 0) {return null;}
  const known = new Map(old.map(photo => [photo.id, photo]));
  const head = fresh.map(photo => ({...photo, is_live_photo: photo.is_live_photo ?? known.get(photo.id)?.is_live_photo}));
  const seen = new Set(fresh.map(photo => photo.id));
  return [...head, ...old.slice(index + 1).filter(photo => !seen.has(photo.id))];
}

export function usePhotos(api: BrowseApi, folderId?: string, favorite = false, filters: PhotoFilters = {}, enabled = true) {
  const {q, mediaType, from, to} = filters;
  const bboxKey = filters.bbox?.join(',');
  const revision = useSyncExternalStore(api.subscribe, api.getRevision);
  const [items, setItems] = useState<Photo[]>([]);
  const [favoritesSupported, setFavoritesSupported] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [moreState, setMoreState] = useState<LoadState>('ready');
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);
  const generation = useRef(0);
  const cursorRef = useRef<string | null>(null);
  const itemsRef = useRef<Photo[]>([]);
  const stateRef = useRef<LoadState>('loading');
  const loaded = useRef<unknown>(null);
  const resetNext = useRef(false);
  const apply = useCallback((update: (old: Photo[]) => Photo[]) => {
    const next = update(itemsRef.current);
    itemsRef.current = next;
    setItems(next);
    return next;
  }, []);
  const settle = useCallback((next: LoadState) => {stateRef.current = next; setState(next);}, []);

  const load = useCallback(async (mode: Mode) => {
    if (!enabled) {return;}
    const restart = mode !== 'more';
    if (busy.current && !restart) {return;}
    // Quiet modes need something on screen to keep; otherwise start over.
    if ((mode === 'refresh' || mode === 'revalidate') && stateRef.current !== 'ready') {mode = 'reset';}
    const ticket = restart ? ++generation.current : generation.current;
    const nextCursor = restart ? undefined : cursorRef.current ?? undefined;
    if (!restart && !nextCursor) {return;}
    busy.current = true;
    if (mode === 'reset') {settle('loading'); apply(() => []); cursorRef.current = null; setCursor(null); setMoreState('ready');}
    else if (mode === 'refresh') {setRefreshing(true);}
    else if (mode === 'more') {setMoreState('loading');}
    try {
      const page = await api.listPhotos(folderId, nextCursor, 50, favorite, {q, mediaType, from, to, ...(bboxKey ? {bbox: bboxKey.split(',').map(Number) as NonNullable<PhotoFilters['bbox']>} : {})});
      if (ticket !== generation.current) {return;}
      const incoming = page.items;
      setFavoritesSupported(page.favorites_supported === true || incoming.some(p => typeof p.is_favorite === 'boolean'));
      const merged = mode === 'revalidate' ? mergeFirstPage(itemsRef.current, incoming) : null;
      const next = apply(old => {
        if (merged) {return merged;}
        if (restart) {return incoming;}
        const seen = new Set(old.map(photo => photo.id));
        return [...old, ...incoming.filter(photo => !seen.has(photo.id))];
      });
      // A merged list keeps its tail, so the tail's cursor is still the next page.
      if (!merged) {cursorRef.current = page.next_cursor; setCursor(page.next_cursor);}
      settle(next.length || !restart ? 'ready' : 'empty');
      setMoreState('ready');
      const ids = incoming.filter(p => p.mime_type.startsWith('image/') && p.is_live_photo === undefined).map(p => p.id);
      // Render thumbnails first; status enrichment can arrive separately.
      api.liveStatus(ids).then(liveIds => {
        if (ticket !== generation.current) {return;}
        const live = new Set(liveIds);
        const requested = new Set(ids);
        apply(old => old.map(p => requested.has(p.id) ? {...p, is_live_photo: live.has(p.id)} : p));
      }).catch(() => {});
    } catch (error) {
      if (ticket !== generation.current) {return;}
      if (!restart && error instanceof ApiError && error.status === 410 && error.code === 'CURSOR_EXPIRED') {
        busy.current = false;
        await load('reset');
        return;
      }
      // A failed quiet update leaves the loaded list on screen; a pull-to-refresh
      // has no other place to report its failure, so it falls back to the error view.
      if (mode === 'reset' || mode === 'refresh') {apply(() => []); cursorRef.current = null; setCursor(null); settle(errorState(error));}
      else if (mode === 'more') {setMoreState(errorState(error));}
      // A quiet update may have displaced a page request; allow it to run again.
      else {setMoreState('ready');}
    } finally {if (ticket === generation.current) {busy.current = false; setRefreshing(false);}}
  }, [api, folderId, favorite, q, mediaType, from, to, bboxKey, enabled, apply, settle]);

  useEffect(() => {
    // The same query with a new revision is a refresh hint, not a new list.
    const sameQuery = loaded.current === load;
    loaded.current = load;
    const quiet = sameQuery && !resetNext.current;
    resetNext.current = false;
    load(quiet ? 'revalidate' : 'reset');
    const currentGeneration = generation.current;
    return () => {generation.current = currentGeneration + 1; busy.current = false;};
  }, [load, revision]);

  // Removing the last loaded photo must not leave a blank 'ready' list.
  const drop = useCallback((ids: string[]) => {
    const removed = new Set(ids);
    if (!itemsRef.current.some(photo => removed.has(photo.id))) {return;}
    const next = apply(old => old.filter(photo => !removed.has(photo.id)));
    if (next.length || stateRef.current !== 'ready') {return;}
    if (cursorRef.current) {load('more');} else {settle('empty');}
  }, [apply, load, settle]);

  useEffect(() => api.onPhotoChange(change => {
    if (change.type === 'reset') {resetNext.current = true; return;}
    if (change.type === 'removed') {drop(change.ids); return;}
    const known = itemsRef.current.some(photo => photo.id === change.id);
    if (favorite) {
      // A favorites-only list loses the photo, or must fetch one it never had.
      if (!change.value) {drop([change.id]);} else if (!known) {load('refresh');}
      return;
    }
    if (known) {apply(old => old.map(photo => photo.id === change.id ? {...photo, is_favorite: change.value} : photo));}
  }), [api, apply, drop, load, favorite]);

  return {remove: drop, items, cursor, state, moreState, refreshing, favoritesSupported, refresh: () => load('refresh'), loadMore: () => load('more')};
}
