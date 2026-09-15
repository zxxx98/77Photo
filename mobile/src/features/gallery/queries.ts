import type { QueryFunctionContext } from '@tanstack/react-query';

import {
  ApiError,
  clearSessionQueries,
  type ApiClient,
  type ListPhotosOptions,
} from '../../services/api/client';
import type { Photo, PhotoPage } from '../../services/api/types';

export { clearSessionQueries };

export const photoKeys = {
  all: (serverId: string, userId: string) => ['photos', serverId, userId] as const,
  list: (serverId: string, userId: string, folderId?: string) =>
    [...photoKeys.all(serverId, userId), 'list', folderId ?? 'timeline'] as const,
};

export const folderKeys = {
  all: (serverId: string, userId: string) => ['folders', serverId, userId] as const,
  list: (serverId: string, userId: string, parentId?: string) =>
    [...folderKeys.all(serverId, userId), 'list', parentId ?? 'root'] as const,
  detail: (serverId: string, userId: string, folderId: string) =>
    [...folderKeys.all(serverId, userId), 'detail', folderId] as const,
};

export type PhotoDayGroup = {
  key: string;
  ids: string[];
};

export type PhotoQueryApi = Pick<ApiClient, 'listPhotos'>;
export type PhotoQueryScope = {
  api: PhotoQueryApi;
  serverId: string;
  userId: string;
  folderId?: string;
  limit?: number;
};

export type FolderQueryApi = Pick<ApiClient, 'listFolders' | 'getFolder'>;

export function groupPhotosByLocalDay(
  photos: readonly Photo[],
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): PhotoDayGroup[] {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const groups: PhotoDayGroup[] = [];
  const positions = new Map<string, number>();
  for (const item of photos) {
    const parts = formatter.formatToParts(new Date(item.captured_at));
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const key = `${values.year}-${values.month}-${values.day}`;
    let position = positions.get(key);
    if (position === undefined) {
      position = groups.length;
      positions.set(key, position);
      groups.push({ key, ids: [] });
    }
    groups[position].ids.push(item.id);
  }
  return groups;
}

export function appendPhotoPages(pages: readonly PhotoPage[]): Photo[] {
  const seen = new Set<string>();
  const photos: Photo[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        photos.push(item);
      }
    }
  }
  return photos;
}

export async function fetchPhotoPage(
  api: PhotoQueryApi,
  options: ListPhotosOptions = {},
): Promise<PhotoPage> {
  try {
    return await api.listPhotos(options);
  } catch (error) {
    if (!options.cursor || !(error instanceof ApiError) || error.code !== 'CURSOR_EXPIRED') {
      throw error;
    }
    const firstPageOptions = { ...options };
    delete firstPageOptions.cursor;
    return api.listPhotos(firstPageOptions);
  }
}

export class CursorExpiredError extends Error {
  constructor() {
    super('photo cursor expired');
    this.name = 'CursorExpiredError';
  }
}

export function photoListQueryOptions(scope: PhotoQueryScope) {
  const { api, serverId, userId, folderId, limit = 50 } = scope;
  return {
    queryKey: photoKeys.list(serverId, userId, folderId),
    queryFn: async ({ pageParam, signal }: QueryFunctionContext<typeof photoKeys.list extends (...args: never[]) => infer T ? T : never, string | undefined>) => {
      try {
        const options: ListPhotosOptions = { limit, signal };
        if (folderId) options.folderId = folderId;
        if (pageParam) options.cursor = pageParam;
        return await api.listPhotos(options);
      } catch (error) {
        if (pageParam && error instanceof ApiError && error.code === 'CURSOR_EXPIRED') {
          throw new CursorExpiredError();
        }
        throw error;
      }
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: PhotoPage, allPages: PhotoPage[], lastPageParam: string | undefined) => {
      const next = lastPage.next_cursor ?? undefined;
      return next && next !== lastPageParam ? next : undefined;
    },
    staleTime: 30_000,
  };
}

export function folderListQueryOptions(
  api: FolderQueryApi,
  serverId: string,
  userId: string,
  parentId?: string,
) {
  return {
    queryKey: folderKeys.list(serverId, userId, parentId),
    queryFn: () => api.listFolders(parentId),
    staleTime: 30_000,
  };
}
