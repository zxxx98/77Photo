import {useCallback, useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {ApiError} from '../auth/api';
import {BrowseApi, errorState, type LoadState, type Photo} from './api';

export function usePhotos(api: BrowseApi, folderId?: string) {
  const revision = useSyncExternalStore(api.subscribe, api.getRevision);
  const [items, setItems] = useState<Photo[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [moreState, setMoreState] = useState<LoadState>('ready');
  const busy = useRef(false);
  const generation = useRef(0);
  const cursorRef = useRef<string | null>(null);

  const load = useCallback(async (restart: boolean) => {
    if (busy.current && !restart) {return;}
    const ticket = restart ? ++generation.current : generation.current;
    const nextCursor = restart ? undefined : cursorRef.current ?? undefined;
    if (!restart && !nextCursor) {return;}
    busy.current = true;
    if (restart) {setState('loading'); setItems([]); cursorRef.current = null; setCursor(null);}
    else {setMoreState('loading');}
    try {
      const page = await api.listPhotos(folderId, nextCursor);
      if (ticket !== generation.current) {return;}
      const incoming = page.items;
      setItems(old => restart ? incoming : [...old, ...incoming.filter(p => !old.some(existing => existing.id === p.id))]);
      cursorRef.current = page.next_cursor;
      setCursor(page.next_cursor);
      setState(incoming.length || !restart ? 'ready' : 'empty');
      setMoreState('ready');
      const ids = incoming.filter(p => p.mime_type.startsWith('image/') && p.is_live_photo === undefined).map(p => p.id);
      // Render thumbnails first; status enrichment can arrive separately.
      api.liveStatus(ids).then(liveIds => {
        if (ticket !== generation.current) {return;}
        const live = new Set(liveIds);
        const requested = new Set(ids);
        setItems(old => old.map(p => requested.has(p.id) ? {...p, is_live_photo: live.has(p.id)} : p));
      }).catch(() => {});
    } catch (error) {
      if (ticket !== generation.current) {return;}
      if (!restart && error instanceof ApiError && error.status === 410 && error.code === 'CURSOR_EXPIRED') {
        busy.current = false;
        await load(true);
        return;
      }
      if (restart) {setState(errorState(error));} else {setMoreState(errorState(error));}
    } finally {if (ticket === generation.current) {busy.current = false;}}
  }, [api, folderId]);

  useEffect(() => {
    load(true);
    const currentGeneration = generation.current;
    return () => {generation.current = currentGeneration + 1; busy.current = false;};
  }, [load, revision]);
  return {items, cursor, state, moreState, refresh: () => load(true), loadMore: () => load(false)};
}
